/**
 * Why an extension is not working: a closed label set, with evidence.
 *
 * A pass rate says how many migrations failed. It cannot say whether they failed because the
 * platform forbids what the extension did, because the model was not good enough, or because the
 * harness could not test it — and those three support opposite conclusions from the same number.
 *
 * Two rules keep the labels worth having:
 *
 *   1. The set is closed. A free-text reason cannot be counted, and an open set drifts until two
 *      annotators (or two runs of the same model) stop agreeing.
 *   2. Every label carries evidence, and IMPOSSIBLE additionally requires a citable platform
 *      constraint. Without that requirement "impossible" quietly degrades into "hard", which is a
 *      claim about the annotator rather than about Chrome.
 *
 * Labels are never assigned automatically from a failed run. The harness may only state facts
 * about its own execution (INVALID_INSTANCE, HARNESS_FAILURE); everything else is adjudication.
 */

export type FailureLabel =
    /** No MV3 implementation preserves the behaviour. Requires a platform-documentation URL. */
    | "IMPOSSIBLE_PLATFORM"
    /** Migratable in principle, but only by dropping observable behaviour. */
    | "DEGRADED_ONLY"
    /** Some model or human produced a working migration, so this run is a model failure. */
    | "POSSIBLE_MODEL_FAILED"
    /** The model stopped early, refused, or produced an incomplete edit. */
    | "MODEL_INCOMPLETE"
    /** The model wrote code calling APIs that do not exist. */
    | "MODEL_HALLUCINATED_API"
    /** The output is MV3-valid but silently does nothing: listeners lost, state gone. */
    | "SILENT_BEHAVIOUR_LOSS"
    /** Minified, bundled or obfuscated beyond what the model could edit. */
    | "SOURCE_NOT_EDITABLE"
    /** The extension needs an account, a device, or a paid service to exercise at all. */
    | "NOT_TESTABLE"
    /** The original MV2 extension did not work either; not evidence about the migration. */
    | "INVALID_INSTANCE"
    /** The harness broke: browser launch, timeout, container error. */
    | "HARNESS_FAILURE";

export const FAILURE_LABELS: { label: FailureLabel; describe: string; needsConstraintUrl: boolean }[] = [
    {
        label: "IMPOSSIBLE_PLATFORM",
        describe: "MV3 has no way to express what the extension does; cite the Chrome documentation that says so.",
        needsConstraintUrl: true,
    },
    {
        label: "DEGRADED_ONLY",
        describe: "A partial MV3 version is possible but loses observable behaviour; say which.",
        needsConstraintUrl: true,
    },
    {
        label: "POSSIBLE_MODEL_FAILED",
        describe: "Another model or a human migrated this successfully; cite the run that proves it.",
        needsConstraintUrl: false,
    },
    { label: "MODEL_INCOMPLETE", describe: "The model stopped early or left edits unfinished.", needsConstraintUrl: false },
    {
        label: "MODEL_HALLUCINATED_API",
        describe: "The output calls APIs that do not exist in MV3.",
        needsConstraintUrl: false,
    },
    {
        label: "SILENT_BEHAVIOUR_LOSS",
        describe: "Loads as valid MV3 but does nothing: listeners lost, state gone, rules never enabled.",
        needsConstraintUrl: false,
    },
    {
        label: "SOURCE_NOT_EDITABLE",
        describe: "Minified, bundled or obfuscated past the point the model could edit it.",
        needsConstraintUrl: false,
    },
    { label: "NOT_TESTABLE", describe: "Needs an account, device or paid service to exercise.", needsConstraintUrl: false },
    {
        label: "INVALID_INSTANCE",
        describe: "The original MV2 extension did not work either, so this says nothing about the migration.",
        needsConstraintUrl: false,
    },
    { label: "HARNESS_FAILURE", describe: "Browser launch, timeout or container error.", needsConstraintUrl: false },
];

/** Labels the harness itself may assign: facts about the run, not judgements about the platform. */
export const HARNESS_ASSIGNABLE: FailureLabel[] = ["INVALID_INSTANCE", "HARNESS_FAILURE"];

export interface LabelEvidence {
    file: string;
    line?: number;
    snippet?: string;
}

/** One adjudication of one extension. Multiple may exist: an LLM's and a human's, for agreement. */
export interface Adjudication {
    extension: string;
    label: FailureLabel;
    /** Prose: what is wrong, in terms a reader can check against the evidence. */
    description: string;
    evidence: LabelEvidence[];
    /** Required for IMPOSSIBLE_PLATFORM and DEGRADED_ONLY: the documentation that states the limit. */
    constraintUrl?: string | null;
    /** For POSSIBLE_MODEL_FAILED: the run id that demonstrates the migration is possible. */
    provenBy?: string | null;
    /** `llm:<model>` or `human:<name>` — required so agreement can be measured. */
    annotator: string;
    confidence?: number | null;
    adjudicatedAt: string;
}

export interface ValidationIssue {
    field: string;
    problem: string;
}

/**
 * Check an adjudication before it is stored.
 *
 * Run at write time on purpose: a validator you meet after three hundred rows is a validator that
 * tells you about three hundred bad rows.
 */
export function validateAdjudication(record: Partial<Adjudication>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const known = FAILURE_LABELS.find((l) => l.label === record.label);

    if (!record.extension) issues.push({ field: "extension", problem: "missing" });
    if (!known) {
        issues.push({ field: "label", problem: `not one of the ${FAILURE_LABELS.length} defined labels` });
    }
    if (!record.description || record.description.trim().length < 10) {
        issues.push({ field: "description", problem: "missing or too short to check against the evidence" });
    }
    if (!record.evidence || record.evidence.length === 0) {
        issues.push({ field: "evidence", problem: "at least one file reference is required" });
    }
    if (!record.annotator || !/^(llm|human|derived):/.test(record.annotator)) {
        issues.push({ field: "annotator", problem: 'must start with "llm:", "human:" or "derived:"' });
    }
    if (known?.needsConstraintUrl && !record.constraintUrl) {
        // Without this, the label degrades into "the annotator found it hard".
        issues.push({ field: "constraintUrl", problem: `${record.label} requires a citable platform constraint` });
    }
    if (record.label === "POSSIBLE_MODEL_FAILED" && !record.provenBy) {
        issues.push({ field: "provenBy", problem: "requires the run id that proves the migration is possible" });
    }
    if (record.confidence != null && (record.confidence < 0 || record.confidence > 1)) {
        issues.push({ field: "confidence", problem: "must be between 0 and 1" });
    }
    return issues;
}

/** The instruction block handed to an LLM adjudicator, derived from the same table. */
export function labelInstructions(): string {
    const lines = FAILURE_LABELS.map(
        (l) => `- ${l.label}: ${l.describe}${l.needsConstraintUrl ? " REQUIRES constraintUrl." : ""}`,
    );
    return [
        "Choose exactly ONE label from this closed set. Do not invent a label.",
        ...lines,
        "",
        "Rules:",
        "- Cite evidence: file, line and a short snippet for every claim.",
        "- A HARD compat finding on an unused code path is NOT grounds for IMPOSSIBLE_PLATFORM.",
        "- If another run migrated this extension successfully, the label is POSSIBLE_MODEL_FAILED.",
        "- Prefer NOT_TESTABLE over guessing when the evidence does not support a judgement.",
    ].join("\n");
}
