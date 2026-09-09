import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunOutcome = "migrated" | "possible_failure" | "failed";

/** One behavioural check, run identically against the MV2 baseline and the MV3 result. */
export interface CheckResult {
    name: string;
    status: "pass" | "fail" | "na";
    detail?: string;
}

/**
 * Labels the harness may assign. The remaining labels an analysis needs — IMPOSSIBLE,
 * DEGRADED_ONLY, POSSIBLE_MODEL_FAILED — are adjudication verdicts that require evidence (a
 * citable platform constraint, or a demonstration that some model or human CAN do it), so they
 * are never produced automatically; a null label means "not yet adjudicated".
 */
export type RunLabel = "INVALID_INSTANCE" | "HARNESS_FAILURE";

/** Result summary written to a run's report.json by the migrator container. */
export interface RunReport {
    /** Chrome loaded it and the MV3 service worker registered. Deliberately unchanged in meaning. */
    passed: boolean;
    verdict?: string;
    reason?: string | null;
    model?: string;
    /** The MV2 original under the same checks. Null when no original was mounted. */
    baseline?: { loaded: boolean; checks: CheckResult[]; error: string | null } | null;
    behaviour?: { loaded: boolean; checks: CheckResult[]; error: string | null } | null;
    /** Fraction of baseline-passing checks preserved, or null when there is no baseline. */
    score?: number | null;
    scoreDenominator?: number;
    regressions?: string[];
    blockers?: {
        input: unknown[];
        output: unknown[];
        /** True when the ORIGINAL uses a capability MV3 cannot express: the per-extension ceiling. */
        inputHasHardBlocker: boolean | null;
    };
    /** The agent declined to migrate. Kept out of the pass rate on purpose (see runMigration.ts). */
    abstained?: boolean;
    abstainReason?: string | null;
    label?: RunLabel | null;
    turns?: number;
    fixAttempts?: number;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd: number };
    wallTimeMs?: number;
}

/** Read the migration verification report for a job dir, or null. */
export function readRunReport(jobDir: string): RunReport | null {
    const reportPath = join(jobDir, "report.json");
    if (!existsSync(reportPath)) return null;
    try {
        return JSON.parse(readFileSync(reportPath, "utf8")) as RunReport;
    } catch {
        return null;
    }
}

/**
 * Classify a finished job. Exit 0 means migrated. A non-zero exit with a
 * report whose passed is false means the migration ran but Chrome could not
 * load the result: a possible failure, not a hard one. No report means the
 * container crashed before verifying.
 */
export function classifyRun(jobDir: string, exitCode: number): RunOutcome {
    if (exitCode === 0) return "migrated";
    const report = readRunReport(jobDir);
    if (report && report.passed === false) return "possible_failure";
    return "failed";
}

/**
 * Is this run admissible evidence about the model at all? An instance whose MV2 original does not
 * work under our own checks grades nothing, and including it understates model capability — so it
 * leaves the denominator instead of counting as a failure.
 */
export function isGradeable(report: RunReport | null): boolean {
    if (!report) return false;
    if (report.label === "INVALID_INSTANCE" || report.label === "HARNESS_FAILURE") return false;
    return true;
}
