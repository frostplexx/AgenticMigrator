import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunOutcome = "migrated" | "possible_failure" | "failed";

/** Result summary written to a run's report.json by the migrator container. */
export interface RunReport {
    passed: boolean;
    verdict?: string;
    reason?: string | null;
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
