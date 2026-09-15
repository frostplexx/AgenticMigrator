import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Chrome's id for an unpacked extension: the first 16 bytes of SHA-256 over the absolute path,
 * each nibble mapped into a-p.
 *
 * Deterministic, which is what lets the harness reach an extension's own pages without a background
 * context to ask. Its own module because both verify.ts and behaviour.ts need it and they already
 * depend on each other in the other direction.
 */
export function unpackedExtensionId(extDir: string): string {
    const digest = createHash("sha256").update(resolve(extDir)).digest("hex").slice(0, 32);
    return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
