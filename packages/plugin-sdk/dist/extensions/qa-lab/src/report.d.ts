export type QaReportCheck = {
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
};
export type QaReportScenario = {
    name: string;
    status: "pass" | "fail" | "skip";
    details?: string;
    steps?: QaReportCheck[];
};
export declare function renderQaMarkdownReport(params: {
    title: string;
    startedAt: Date;
    finishedAt: Date;
    checks?: QaReportCheck[];
    scenarios?: QaReportScenario[];
    timeline?: string[];
    notes?: string[];
}): string;
