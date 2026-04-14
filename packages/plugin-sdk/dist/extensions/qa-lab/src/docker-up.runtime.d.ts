import { resolveHostPort, type FetchLike, type RunCommand } from "./docker-runtime.js";
type QaDockerUpResult = {
    outputDir: string;
    composeFile: string;
    qaLabUrl: string;
    gatewayUrl: string;
    stopCommand: string;
};
export declare function runQaDockerUp(params: {
    repoRoot?: string;
    outputDir?: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    bindUiDist?: boolean;
    skipUiBuild?: boolean;
}, deps?: {
    runCommand?: RunCommand;
    fetchImpl?: FetchLike;
    sleepImpl?: (ms: number) => Promise<unknown>;
    resolveHostPortImpl?: typeof resolveHostPort;
}): Promise<QaDockerUpResult>;
export {};
