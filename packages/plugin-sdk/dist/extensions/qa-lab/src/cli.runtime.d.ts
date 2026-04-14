import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { type QaProviderModeInput } from "./run-config.js";
export declare function runQaLabSelfCheckCommand(opts: {
    repoRoot?: string;
    output?: string;
}): Promise<void>;
export declare function runQaSuiteCommand(opts: {
    repoRoot?: string;
    outputDir?: string;
    transportId?: string;
    runner?: string;
    providerMode?: QaProviderModeInput;
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    cliAuthMode?: string;
    parityPack?: string;
    scenarioIds?: string[];
    concurrency?: number;
    image?: string;
    cpus?: number;
    memory?: string;
    disk?: string;
}): Promise<void>;
export declare function runQaParityReportCommand(opts: {
    repoRoot?: string;
    candidateSummary: string;
    baselineSummary: string;
    candidateLabel?: string;
    baselineLabel?: string;
    outputDir?: string;
}): Promise<void>;
export declare function runQaCharacterEvalCommand(opts: {
    repoRoot?: string;
    outputDir?: string;
    model?: string[];
    scenario?: string;
    fast?: boolean;
    thinking?: string;
    modelThinking?: string[];
    judgeModel?: string[];
    judgeTimeoutMs?: number;
    blindJudgeModels?: boolean;
    concurrency?: number;
    judgeConcurrency?: number;
}): Promise<void>;
export declare function runQaManualLaneCommand(opts: {
    repoRoot?: string;
    transportId?: string;
    providerMode?: QaProviderModeInput;
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    message: string;
    timeoutMs?: number;
}): Promise<void>;
export declare function runQaCredentialsAddCommand(opts: {
    actorId?: string;
    endpointPrefix?: string;
    json?: boolean;
    kind: string;
    note?: string;
    payloadFile: string;
    repoRoot?: string;
    siteUrl?: string;
}): Promise<void>;
export declare function runQaCredentialsRemoveCommand(opts: {
    actorId?: string;
    credentialId: string;
    endpointPrefix?: string;
    json?: boolean;
    siteUrl?: string;
}): Promise<void>;
export declare function runQaCredentialsListCommand(opts: {
    actorId?: string;
    endpointPrefix?: string;
    json?: boolean;
    kind?: string;
    limit?: number;
    showSecrets?: boolean;
    siteUrl?: string;
    status?: string;
}): Promise<void>;
export declare function runQaLabUiCommand(opts: {
    repoRoot?: string;
    host?: string;
    port?: number;
    advertiseHost?: string;
    advertisePort?: number;
    controlUiUrl?: string;
    controlUiToken?: string;
    controlUiProxyTarget?: string;
    uiDistDir?: string;
    autoKickoffTarget?: string;
    embeddedGateway?: string;
    sendKickoffOnStart?: boolean;
}): Promise<void>;
export declare function runQaDockerScaffoldCommand(opts: {
    repoRoot?: string;
    outputDir: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    bindUiDist?: boolean;
}): Promise<void>;
export declare function runQaDockerBuildImageCommand(opts: {
    repoRoot?: string;
    image?: string;
}): Promise<void>;
export declare function runQaDockerUpCommand(opts: {
    repoRoot?: string;
    outputDir?: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    bindUiDist?: boolean;
    skipUiBuild?: boolean;
}): Promise<void>;
export declare function runQaMockOpenAiCommand(opts: {
    host?: string;
    port?: number;
}): Promise<void>;
export declare const __testing: {
    resolveRepoRelativeOutputDir: typeof resolveRepoRelativeOutputDir;
};
