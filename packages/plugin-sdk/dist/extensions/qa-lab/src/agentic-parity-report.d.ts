export type QaParityReportStep = {
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
};
export type QaParityReportScenario = {
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
    steps?: QaParityReportStep[];
};
/**
 * Optional self-describing run metadata written by PR L (#64789). Before
 * that PR merges, older summaries only have `scenarios` + `counts`; the
 * parity report treats a missing `run` block as "unknown provenance" and
 * skips the label-match verification for backwards compatibility
 * with legacy summaries that predate the run metadata block.
 */
export type QaParityRunBlock = {
    primaryProvider?: string;
    primaryModel?: string;
    primaryModelName?: string;
    providerMode?: string;
    scenarioIds?: readonly string[] | null;
};
export type QaParitySuiteSummary = {
    scenarios: QaParityReportScenario[];
    counts?: {
        total?: number;
        passed?: number;
        failed?: number;
    };
    /** Self-describing run metadata — see PR L #64789 for the writer side. */
    run?: QaParityRunBlock;
};
export type QaAgenticParityMetrics = {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    completionRate: number;
    unintendedStopCount: number;
    unintendedStopRate: number;
    validToolCallCount: number;
    validToolCallRate: number;
    fakeSuccessCount: number;
};
export type QaAgenticParityScenarioComparison = {
    name: string;
    candidateStatus: "pass" | "fail" | "skip" | "missing";
    baselineStatus: "pass" | "fail" | "skip" | "missing";
    candidateDetails?: string;
    baselineDetails?: string;
};
export type QaAgenticParityComparison = {
    candidateLabel: string;
    baselineLabel: string;
    comparedAt: string;
    candidateMetrics: QaAgenticParityMetrics;
    baselineMetrics: QaAgenticParityMetrics;
    scenarioComparisons: QaAgenticParityScenarioComparison[];
    pass: boolean;
    failures: string[];
    notes: string[];
};
export declare function computeQaAgenticParityMetrics(summary: QaParitySuiteSummary): QaAgenticParityMetrics;
export declare class QaParityLabelMismatchError extends Error {
    readonly role: "candidate" | "baseline";
    readonly label: string;
    readonly runProvider: string;
    readonly runModel: string;
    constructor(params: {
        role: "candidate" | "baseline";
        label: string;
        runProvider: string;
        runModel: string;
    });
}
export declare function buildQaAgenticParityComparison(params: {
    candidateLabel: string;
    baselineLabel: string;
    candidateSummary: QaParitySuiteSummary;
    baselineSummary: QaParitySuiteSummary;
    comparedAt?: string;
}): QaAgenticParityComparison;
export declare function renderQaAgenticParityMarkdownReport(comparison: QaAgenticParityComparison): string;
