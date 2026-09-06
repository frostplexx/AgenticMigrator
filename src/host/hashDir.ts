// Content hash of a directory tree, used to decide whether the Docker image is stale.
// Kept out of cli.ts because that module runs main() on import and cannot be imported by tests.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Stable content hash over every file under `dir` (path + bytes, sorted). */
export function hashDir(dir: string): string {
    const entries: string[] = [];
    function walk(d: string) {
        for (const entry of readdirSync(d)) {
            const p = join(d, entry);
            if (statSync(p).isDirectory()) walk(p);
            else entries.push(relative(dir, p));
        }
    }
    walk(dir);
    entries.sort();
    const h = createHash("sha256");
    for (const e of entries) {
        h.update(e);
        h.update(readFileSync(join(dir, e)));
    }
    return h.digest("hex").slice(0, 16);
}
