// Host-side pre-pass: run GoogleChromeLabs extension-manifest-converter (vendored Python)
// over the extension, exactly like src/utils/manifest_converter.py. Deterministic MV2->MV3
// search-and-replace; the agent finishes the rest. Falls back to an unconverted copy if the
// converter is missing or fails, so the pipeline always proceeds.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Path to the vendored converter. Override with EMC_DIR; defaults to the Python repo's copy.
const EMC_DIR =
    process.env.EMC_DIR ??
    "/Users/daniel/Projects/AgenticMigrator/third_party/extension-manifest-converter";

/** Returns a fresh temp dir holding the converted extension. Caller owns/removes it. */
export function convert(extensionPath: string): { dir: string; log: string } {
    const out = mkdtempSync(join(tmpdir(), "emc-converted-"));
    if (!existsSync(join(EMC_DIR, "emc.py"))) {
        cpSync(extensionPath, out, { recursive: true });
        return { dir: out, log: `converter not found at ${EMC_DIR}; using extension unconverted` };
    }
    const work = mkdtempSync(join(tmpdir(), "emc-work-"));
    try {
        const srcCopy = join(work, "extension");
        cpSync(extensionPath, srcCopy, { recursive: true });
        let log = "";
        try {
            log = execFileSync("python3", ["emc.py", srcCopy], {
                cwd: EMC_DIR,
                encoding: "utf8",
                timeout: 120_000,
            });
        } catch (e: any) {
            cpSync(extensionPath, out, { recursive: true });
            return { dir: out, log: `converter failed (${e.message}); using extension unconverted` };
        }
        const converted = srcCopy + "_delete";
        if (existsSync(join(converted, "manifest.json"))) {
            cpSync(converted, out, { recursive: true });
            return { dir: out, log: log.trim() };
        }
        cpSync(extensionPath, out, { recursive: true });
        return { dir: out, log: "converter produced no manifest; using extension unconverted" };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
