/**
 * The content-addressed store.
 *
 * This is the one component in the pipeline that can silently corrupt finished results: a hardlink
 * has no copy-on-write, so getting the linking or the collection wrong changes the contents of runs
 * that were recorded weeks ago. So the tests care about identity (same inode, and therefore one copy
 * on disk) and about what survives a delete — not merely about the byte counts being plausible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, dedupe } from "../src/host/blobs.js";

/** Above the 4096-byte floor, so it is a file the store bothers with. */
const BIG = "x".repeat(8192);
const BIG2 = "y".repeat(8192);

function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "blobs-"));
    for (const [rel, content] of Object.entries(files)) {
        const path = join(root, rel);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
    }
    return root;
}

const inode = (path: string): number => statSync(path).ino;

test("identical content in two runs ends up as one copy on disk", () => {
    const root = tree({ "a/out/icon.png": BIG, "b/out/icon.png": BIG });
    const store = join(root, "blobs");
    try {
        const first = dedupe(join(root, "a/out"), store);
        const second = dedupe(join(root, "b/out"), store);

        // The only claim that matters: one inode, so one copy of the bytes.
        assert.equal(inode(join(root, "a/out/icon.png")), inode(join(root, "b/out/icon.png")));
        assert.equal(first.linked, 1);
        assert.equal(second.linked, 1);
        // The second run added nothing and freed its own duplicate.
        assert.equal(first.addedBytes, 8192);
        assert.equal(second.addedBytes, 0);
        assert.equal(second.freedBytes, 8192);
        // And both files still read as themselves.
        assert.equal(readFileSync(join(root, "b/out/icon.png"), "utf8"), BIG);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("different content stays separate", () => {
    const root = tree({ "a/out/sw.js": BIG, "b/out/sw.js": BIG2 });
    const store = join(root, "blobs");
    try {
        dedupe(join(root, "a/out"), store);
        dedupe(join(root, "b/out"), store);
        assert.notEqual(inode(join(root, "a/out/sw.js")), inode(join(root, "b/out/sw.js")));
        assert.equal(readFileSync(join(root, "a/out/sw.js"), "utf8"), BIG);
        assert.equal(readFileSync(join(root, "b/out/sw.js"), "utf8"), BIG2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("running twice over one run changes nothing", () => {
    const root = tree({ "a/out/icon.png": BIG });
    const store = join(root, "blobs");
    try {
        dedupe(join(root, "a/out"), store);
        const before = inode(join(root, "a/out/icon.png"));
        const again = dedupe(join(root, "a/out"), store);
        // Recognised by inode rather than re-linked: a second pass is idempotent, which matters
        // because a resumed batch will dedupe extensions it already did.
        assert.equal(inode(join(root, "a/out/icon.png")), before);
        assert.equal(again.linked, 1);
        assert.equal(again.addedBytes, 0);
        assert.equal(again.freedBytes, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("small files are left alone", () => {
    const root = tree({ "a/out/manifest.json": "{}" });
    const store = join(root, "blobs");
    try {
        const result = dedupe(join(root, "a/out"), store);
        // A link costs an inode and one more thing that must never be written through; below a block
        // there is nothing to win.
        assert.equal(result.files, 1);
        assert.equal(result.linked, 0);
        assert.equal(statSync(join(root, "a/out/manifest.json")).nlink, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("symlinks are not followed into the store", () => {
    const root = tree({ "a/out/real.js": BIG });
    const store = join(root, "blobs");
    try {
        symlinkSync(join(root, "a/out/real.js"), join(root, "a/out/link.js"));
        const result = dedupe(join(root, "a/out"), store);
        // Linking a symlink's target in would silently change what the extension contains.
        assert.equal(result.linked, 1);
        assert.equal(statSync(join(root, "a/out/link.js"), { bigint: false }).isFile(), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("deleting a run frees only the blobs no other run shares", () => {
    const root = tree({ "a/out/shared.png": BIG, "a/out/only-a.js": BIG2, "b/out/shared.png": BIG });
    const store = join(root, "blobs");
    try {
        dedupe(join(root, "a/out"), store);
        dedupe(join(root, "b/out"), store);

        // Run A goes, as runs.delete would remove it.
        rmSync(join(root, "a"), { recursive: true, force: true });
        const collected = collect(store);

        // only-a.js was reachable from A alone, so it is garbage; shared.png is still B's.
        assert.equal(collected.removed, 1);
        assert.equal(collected.freedBytes, 8192);
        assert.equal(readFileSync(join(root, "b/out/shared.png"), "utf8"), BIG);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("collecting an untouched store removes nothing", () => {
    const root = tree({ "a/out/icon.png": BIG });
    const store = join(root, "blobs");
    try {
        dedupe(join(root, "a/out"), store);
        assert.deepEqual(collect(store), { removed: 0, freedBytes: 0 });
        assert.equal(readFileSync(join(root, "a/out/icon.png"), "utf8"), BIG);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing tree or store is not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "blobs-"));
    try {
        assert.deepEqual(dedupe(join(root, "nope"), join(root, "blobs")).files, 0);
        assert.deepEqual(collect(join(root, "no-store")), { removed: 0, freedBytes: 0 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// What the numbers are actually for: proving the duplication is gone across many runs of one corpus.
test("N runs of one unchanged corpus cost one copy, not N", () => {
    const files: Record<string, string> = {};
    for (const run of ["r1", "r2", "r3", "r4", "r5"]) {
        files[`${run}/out/lib.js`] = BIG;
        files[`${run}/out/icon.png`] = BIG2;
    }
    const root = tree(files);
    const store = join(root, "blobs");
    try {
        let added = 0;
        let freed = 0;
        for (const run of ["r1", "r2", "r3", "r4", "r5"]) {
            const result = dedupe(join(root, run, "out"), store);
            added += result.addedBytes;
            freed += result.freedBytes;
        }
        // Two distinct files, one copy each, whatever the number of runs.
        assert.equal(added, 2 * 8192);
        assert.equal(freed, 4 * 2 * 8192);
        assert.equal(inode(join(root, "r1/out/lib.js")), inode(join(root, "r5/out/lib.js")));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
