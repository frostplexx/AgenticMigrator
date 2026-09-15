import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeRecord } from "./changes.js";
import type { Tag, TagKind } from "./tags.js";
import { HARNESS_ASSIGNABLE } from "./labels.js";
import type { PromptRef } from "./promptRef.js";

export type RunOutcome = "migrated" | "possible_failure" | "failed";

/** One behavioural check, run identically against the MV2 baseline and the MV3 result. */
export interface CheckResult {
    name: string;
    status: "pass" | "fail" | "na";
    detail?: string;
}

/**
 * Labels the harness may assign: facts about its own execution.
 *
 * The rest of the taxonomy lives in labels.ts and is adjudication — it needs evidence, and in two
 * cases a citable platform constraint — so it is never produced automatically. A null label means
 * "not yet adjudicated", which is different from "nothing was wrong".
 */
export type RunLabel = (typeof HARNESS_ASSIGNABLE)[number];

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
    /** Checks the harness could not judge after migration; excluded from the score's denominator. */
    inconclusive?: string[];
    regressions?: string[];
    blockers?: {
        input: unknown[];
        output: unknown[];
        /** True when the ORIGINAL uses a capability MV3 cannot express: the per-extension ceiling. */
        inputHasHardBlocker: boolean | null;
    };
    /**
     * Every MV2→MV3 change with `needed` and `applied`. The interesting cell is needed &&
     * !applied: a change the platform demanded and the pipeline did not make.
     */
    changes?: ChangeRecord[];
    changeSummary?: { needed: number; applied: number; skipped: number; appliedUnneeded: number };
    /** applied / skipped / repair / misc tags, countable across a corpus. */
    tags?: Tag[];
    tagCounts?: Record<TagKind, number>;
    /**
     * Fingerprint of the starting information. Two runs are only a model comparison when their
     * refs match; see promptRef.ts.
     */
    promptRef?: PromptRef;
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
