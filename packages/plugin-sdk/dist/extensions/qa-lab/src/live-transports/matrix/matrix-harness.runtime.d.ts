import { resolveHostPort, type FetchLike, type RunCommand } from "../../docker-runtime.js";
export type MatrixQaHarnessFiles = {
    outputDir: string;
    composeFile: string;
    manifestPath: string;
    image: string;
    serverName: string;
    homeserverPort: number;
    registrationToken: string;
};
export type MatrixQaHarness = MatrixQaHarnessFiles & {
    baseUrl: string;
    stopCommand: string;
    stop(): Promise<void>;
};
declare function buildVersionsUrl(baseUrl: string): string;
declare function isMatrixVersionsReachable(baseUrl: string, fetchImpl: FetchLike): Promise<boolean>;
declare function waitForReachableMatrixBaseUrl(params: {
    composeFile: string;
    containerBaseUrl: string | null;
    fetchImpl: FetchLike;
    hostBaseUrl: string;
    sleepImpl: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<string>;
declare function resolveMatrixQaHarnessImage(image?: string): string;
declare function renderMatrixQaCompose(params: {
    homeserverPort: number;
    image: string;
    registrationToken: string;
    serverName: string;
}): string;
export declare function writeMatrixQaHarnessFiles(params: {
    outputDir: string;
    image?: string;
    homeserverPort: number;
    registrationToken?: string;
    serverName?: string;
}): Promise<MatrixQaHarnessFiles>;
export declare function startMatrixQaHarness(params: {
    outputDir: string;
    repoRoot?: string;
    image?: string;
    homeserverPort?: number;
    serverName?: string;
}, deps?: {
    fetchImpl?: FetchLike;
    runCommand?: RunCommand;
    sleepImpl?: (ms: number) => Promise<unknown>;
    resolveHostPortImpl?: typeof resolveHostPort;
}): Promise<MatrixQaHarness>;
export declare const __testing: {
    MATRIX_QA_DEFAULT_IMAGE: string;
    MATRIX_QA_DEFAULT_PORT: number;
    MATRIX_QA_DEFAULT_SERVER_NAME: string;
    MATRIX_QA_SERVICE: string;
    buildVersionsUrl: typeof buildVersionsUrl;
    isMatrixVersionsReachable: typeof isMatrixVersionsReachable;
    renderMatrixQaCompose: typeof renderMatrixQaCompose;
    resolveMatrixQaHarnessImage: typeof resolveMatrixQaHarnessImage;
    waitForReachableMatrixBaseUrl: typeof waitForReachableMatrixBaseUrl;
};
export {};
