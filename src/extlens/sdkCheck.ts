/**
 * Is the extlens SDK we loaded the one that was built?
 *
 * `extlens-sdk` is a `file:` dependency, and npm may resolve it as a symlink (rebuilds propagate)
 * or as a *copy* taken at install time (they do not). On a copy, rebuilding extlens changes
 * nothing here, and the failure is silent and deeply misleading: the analyzer looks broken.
 *
 * This cost two debugging sessions, both spent looking at the detector. The symptom was a review
 * form saying an extension has no user-facing surfaces while its manifest plainly declared a popup
 * — because the loaded SDK predated surface detection entirely.
 *
 * So the SDK is probed at startup with a manifest whose answer is known. A mismatch is not fatal
 * — the rest of the server works — but it is stated in terms of the fix rather than the symptom.
 */
import { computeProfile } from "extlens-sdk";
import logger from "../logger.js";

/** A manifest with exactly one unmistakable surface: an action with a popup. */
const PROBE = {
    manifest_version: 3,
    name: "sdk-probe",
    version: "1.0",
    action: { default_popup: "popup.html" },
} as const;

export interface SdkCheck {
    ok: boolean;
    detail: string;
}

/**
 * Verify the loaded SDK computes the profile fields this host relies on.
 *
 * Checks capability, not a version number: a version would have to be bumped by hand and would go
 * stale exactly when it mattered, whereas asking the SDK to analyse a manifest and looking at what
 * comes back cannot be wrong.
 */
export function checkSdk(): SdkCheck {
    let surfaces: unknown;
    try {
        surfaces = (computeProfile({ id: "sdk-probe", manifest: PROBE as never, files: [] }) as { surfaces?: unknown })
            .surfaces;
    } catch (error) {
        return { ok: false, detail: `extlens-sdk threw during a probe analysis: ${String(error)}` };
    }

    if (!Array.isArray(surfaces)) {
        return {
            ok: false,
            detail: "the loaded extlens-sdk does not report user-facing surfaces at all",
        };
    }
    const found = (surfaces as { surface?: string }[]).map((s) => s.surface);
    if (!found.includes("popup")) {
        return {
            ok: false,
            detail: `the loaded extlens-sdk missed the popup in a manifest that declares one (saw: ${found.join(", ") || "nothing"})`,
        };
    }
    return { ok: true, detail: `surfaces: ${found.join(", ")}` };
}

/** Log the check, with the fix rather than the symptom when it fails. */
export function reportSdkCheck(): void {
    const result = checkSdk();
    if (result.ok) {
        logger.silly(`extlens-sdk probe ok (${result.detail})`, { module: "extlens" });
        return;
    }
    logger.warn(`extlens-sdk is out of date — ${result.detail}`, { module: "extlens" });
    logger.warn(
        "the review form will under-report what an extension exposes. Fix: (cd ../extlens && npm run build) " +
            "then, if node_modules/extlens-sdk is a COPY rather than a symlink, re-run npm install here — " +
            "check with: ls -la node_modules/extlens-sdk",
        { module: "extlens" },
    );
}
