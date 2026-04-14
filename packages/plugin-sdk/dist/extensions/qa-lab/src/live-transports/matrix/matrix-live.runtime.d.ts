import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { startQaGatewayChild } from "../../gateway-child.js";
import type { QaReportCheck } from "../../report.js";
import { type QaProviderModeInput } from "../../run-config.js";
import { type MatrixQaObservedEvent } from "./matrix-driver-client.js";
import { type MatrixQaCanaryArtifact, type MatrixQaScenarioArtifacts } from "./matrix-live-scenarios.js";
type MatrixQaScenarioResult = {
    artifacts?: MatrixQaScenarioArtifacts;
    details: string;
    id: string;
    status: "fail" | "pass";
    title: string;
};
type MatrixQaSummary = {
    checks: QaReportCheck[];
    counts: {
        failed: number;
        passed: number;
        total: number;
    };
    finishedAt: string;
    harness: {
        baseUrl: string;
        composeFile: string;
        image: string;
        roomId: string;
        serverName: string;
    };
    canary?: MatrixQaCanaryArtifact;
    observedEventCount: number;
    observedEventsPath: string;
    reportPath: string;
    scenarios: MatrixQaScenarioResult[];
    startedAt: string;
    summaryPath: string;
    sutAccountId: string;
    userIds: {
        driver: string;
        observer: string;
        sut: string;
    };
};
type MatrixQaArtifactPaths = {
    observedEvents: string;
    report: string;
    summary: string;
};
export type MatrixQaRunResult = {
    observedEventsPath: string;
    outputDir: string;
    reportPath: string;
    scenarios: MatrixQaScenarioResult[];
    summaryPath: string;
};
declare function buildMatrixQaSummary(params: {
    artifactPaths: MatrixQaArtifactPaths;
    canary?: MatrixQaCanaryArtifact;
    checks: QaReportCheck[];
    finishedAt: string;
    harness: MatrixQaSummary["harness"];
    observedEventCount: number;
    scenarios: MatrixQaScenarioResult[];
    startedAt: string;
    sutAccountId: string;
    userIds: MatrixQaSummary["userIds"];
}): MatrixQaSummary;
declare function buildMatrixQaConfig(baseCfg: OpenClawConfig, params: {
    driverUserId: string;
    homeserver: string;
    roomId: string;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
}): OpenClawConfig;
declare function buildObservedEventsArtifact(params: {
    includeContent: boolean;
    observedEvents: MatrixQaObservedEvent[];
}): MatrixQaObservedEvent[];
declare function isMatrixAccountReady(entry?: {
    connected?: boolean;
    healthState?: string;
    restartPending?: boolean;
    running?: boolean;
}): boolean;
declare function waitForMatrixChannelReady(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>, accountId: string, opts?: {
    pollMs?: number;
    timeoutMs?: number;
}): Promise<void>;
export declare function runMatrixQaLive(params: {
    fastMode?: boolean;
    outputDir?: string;
    primaryModel?: string;
    providerMode?: QaProviderModeInput;
    repoRoot?: string;
    scenarioIds?: string[];
    sutAccountId?: string;
    alternateModel?: string;
}): Promise<MatrixQaRunResult>;
export declare const __testing: {
    buildMatrixQaSummary: typeof buildMatrixQaSummary;
    MATRIX_QA_SCENARIOS: import("./matrix-live-scenarios.js").MatrixQaScenarioDefinition[];
    buildMatrixQaConfig: typeof buildMatrixQaConfig;
    buildObservedEventsArtifact: typeof buildObservedEventsArtifact;
    isMatrixAccountReady: typeof isMatrixAccountReady;
    waitForMatrixChannelReady: typeof waitForMatrixChannelReady;
};
export {};
