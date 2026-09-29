/**
 * Collapsing the duplication between runs, without any reader having to know.
 *
 * A run's `out/` tree is a full copy of the corpus with the agent's edits on top — 96% of a run
 * directory's bytes, and on the corpus this was measured against, 92% of those bytes are byte-identical
 * to the MV2 source they came from: icons, vendored libraries, images, everything the agent never
 * opens. Five runs over a 200-extension corpus is therefore about 7.5GB of which roughly 1.5GB is
 * distinct.
 *
 * So after a run finishes, every file in it is moved into a content-addressed store and hardlinked
 * back where it was. Identical content anywhere — across runs, across extensions, across both — costs
 * one copy on disk. Nothing downstream changes: `out/` is still an ordinary directory of ordinary
 * files, so Chrome loads the extension from it, the adapter reads files out of it, and a diff against
 * the source works exactly as before. That is the whole reason for choosing hardlinks over an archive
 * or a manifest-and-blobs scheme, both of which would need a materialize step on the path to every
 * reader, Chrome included.
 *
 * TWO RULES, both of which are the difference between this working and this corrupting data:
 *
 *  1. Only ever run this on a FINISHED run. A hardlinked file has no copy-on-write: a process that
 *     opens one and writes in place changes the content of every run sharing it. The agent edits
 *     files in `out/` in place all through a migration, so linking a live run would silently rewrite
 *     the history of every earlier run that shared a byte-identical file.
 *  2. Blobs are never modified or written through. `dedupe` only ever creates them, links them and
 *     unlinks its own copies. Deleting a run is then just deleting its directory: the links drop and
 *     the blob survives while any other run still points at it, which is what `collect` cleans up.
 */
import { createHash } from "node:crypto";
import {
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface DedupeResult {
    /** Files considered. */
    files: number;
    /** Files now hardlinked into the store. */
    linked: number;
    /** Bytes no longer stored twice, because the content was already in the store. */
    freedBytes: number;
    /** Bytes the store grew by: content seen here for the first time. */
    addedBytes: number;
    /** Files left alone, with why. A skip is never an error: the run is still readable. */
    skipped: { path: string; reason: string }[];
}

/**
 * Small files are left alone.
 *
 * A hardlink costs an inode and a directory entry, and below roughly a block there is nothing to
 * win — while every link is one more thing that must not be written through. The bytes that matter
 * are images and bundles, and those are nowhere near this line.
 */
const MIN_SIZE = 4096;

const blobPath = (store: string, hash: string): string => join(store, hash.slice(0, 2), hash.slice(2));

function hashFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Hardlink every sizeable file under `dir` into the store.
 *
 * Idempotent: a file already linked to its blob is recognised by inode and left alone, so running
 * this twice over a run costs a pass of hashing and changes nothing.
 */
export function dedupe(dir: string, store: string): DedupeResult {
    const result: DedupeResult = { files: 0, linked: 0, freedBytes: 0, addedBytes: 0, skipped: [] };
    if (!existsSync(dir)) return result;
    mkdirSync(store, { recursive: true });

    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) {
                walk(path);
                continue;
            }
            // Symlinks are not followed: linking a link's target into the store would silently
            // change what the extension contains.
            if (!entry.isFile()) continue;

            let size: number;
            let nlink: number;
            let ino: number;
            try {
                const stat = statSync(path);
                ({ size, nlink, ino } = stat);
            } catch (e) {
                result.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
                continue;
            }
            result.files++;
            if (size < MIN_SIZE) continue;

            let hash: string;
            try {
                hash = hashFile(path);
            } catch (e) {
                result.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
                continue;
            }
            const blob = blobPath(store, hash);

            try {
                if (existsSync(blob)) {
                    // Already the same inode: this run was deduped before.
                    if (statSync(blob).ino === ino) {
                        result.linked++;
                        continue;
                    }
                    // Replace our copy with a link to the stored one. Via a temp name so a crash
                    // mid-swap leaves the file present under one name or the other, never neither.
                    const temp = `${path}.dedupe-${process.pid}`;
                    linkSync(blob, temp);
                    renameSync(temp, path);
                    result.linked++;
                    result.freedBytes += size;
                } else {
                    mkdirSync(join(store, hash.slice(0, 2)), { recursive: true });
                    // Move ours in and link it back: the file keeps its inode, so anything holding
                    // it open is unaffected, and the store owns the only copy of the content.
                    renameSync(path, blob);
                    linkSync(blob, path);
                    result.linked++;
                    // A file with links elsewhere already counted its bytes for another run.
                    if (nlink === 1) result.addedBytes += size;
                }
            } catch (e) {
                result.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) });
                // A failed swap can leave the temp link behind; it is ours, so it goes.
                rmSync(`${path}.dedupe-${process.pid}`, { force: true });
            }
        }
    };

    walk(dir);
    return result;
}

/**
 * Drop blobs no run points at any more.
 *
 * A deleted run leaves its blobs behind with a link count of one — the store's own. Nothing else can
 * reach them, so they are garbage, and the link count is the whole test: it needs no index of who
 * references what, and it cannot be wrong about a run that was deleted by hand.
 */
export function collect(store: string): { removed: number; freedBytes: number } {
    let removed = 0;
    let freedBytes = 0;
    if (!existsSync(store)) return { removed, freedBytes };
    for (const prefix of readdirSync(store)) {
        const dir = join(store, prefix);
        let entries: string[];
        try {
            if (!statSync(dir).isDirectory()) continue;
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of entries) {
            const blob = join(dir, name);
            try {
                const stat = statSync(blob);
                if (stat.nlink > 1) continue;
                unlinkSync(blob);
                removed++;
                freedBytes += stat.size;
            } catch {
                // Raced with another collect, or not ours to remove. Either way, leave it.
            }
        }
        // An empty shard is noise in the store; its removal is best-effort.
        try {
            if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
        } catch {
            /* fine */
        }
    }
    return { removed, freedBytes };
}
