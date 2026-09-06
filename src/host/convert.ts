// Host-side pre-pass: run GoogleChromeLabs extension-manifest-converter (vendored Python)
// over the extension, exactly like src/utils/manifest_converter.py. Deterministic MV2->MV3
// search-and-replace; the agent finishes the rest. Falls back to an unconverted copy if the
// converter is missing or fails, so the pipeline always proceeds.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the vendored converter. Override with EMC_DIR; defaults to the vendored submodule.
// Resolved relative to the build output (dist/host -> repo root) so it works on any machine;
// this MUST match ensureConverter() in cli.ts, or that guard passes while convert() silently
// falls back to an unconverted copy.
export function emcDir(): string {
    return (
        process.env.EMC_DIR ??
        join(resolve(__dirname, "..", ".."), "third_party", "extension-manifest-converter")
    );
}

const EMC_DIR = emcDir();

/**
 * Returns a fresh temp dir holding the converted extension. Caller owns/removes it.
 * `converted` is false when a fallback fired and the copy is still MV2 — callers should
 * surface that, since an unconverted extension usually ends up failing to load in Chrome.
 */
export function convert(extensionPath: string): { dir: string; log: string; converted: boolean } {
    const out = mkdtempSync(join(tmpdir(), "emc-converted-"));
    if (!existsSync(join(EMC_DIR, "emc.py"))) {
        cpSync(extensionPath, out, { recursive: true });
        return { dir: out, log: `converter not found at ${EMC_DIR}; using extension unconverted`, converted: false };
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
            return { dir: out, log: `converter failed (${e.message}); using extension unconverted`, converted: false };
        }
        const converted = srcCopy + "_delete";
        if (existsSync(join(converted, "manifest.json"))) {
            cpSync(converted, out, { recursive: true });
            // The converter bumps manifest_version deterministically, so anything other than 3
            // here means it did not actually process this manifest (unparseable JSON, an
            // unrecognized layout). Treat that as a failed conversion rather than trusting exit 0.
            const mv = manifestVersion(join(out, "manifest.json"));
            if (mv !== 3) {
                return {
                    dir: out,
                    log: `${log.trim()}\nconverter ran but manifest_version is ${mv ?? "unreadable"}, not 3`,
                    converted: false,
                };
            }
            return { dir: out, log: log.trim(), converted: true };
        }
        cpSync(extensionPath, out, { recursive: true });
        return { dir: out, log: "converter produced no manifest; using extension unconverted", converted: false };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/** manifest_version of a manifest.json, or null when missing/unparseable. */
export function manifestVersion(manifestPath: string): number | null {
    try {
        const v = JSON.parse(readFileSync(manifestPath, "utf8")).manifest_version;
        return typeof v === "number" ? v : null;
    } catch {
        return null;
    }
}
