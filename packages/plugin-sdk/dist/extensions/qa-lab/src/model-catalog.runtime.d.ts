type ModelRow = {
    key: string;
    name: string;
    input: string;
    available: boolean | null;
    missing: boolean;
};
export type QaRunnerModelOption = {
    key: string;
    name: string;
    provider: string;
    input: string;
    preferred: boolean;
};
export declare function selectQaRunnerModelOptions(rows: ModelRow[]): QaRunnerModelOption[];
export declare function loadQaRunnerModelOptions(params: {
    repoRoot: string;
    signal?: AbortSignal;
}): Promise<QaRunnerModelOption[]>;
export {};
