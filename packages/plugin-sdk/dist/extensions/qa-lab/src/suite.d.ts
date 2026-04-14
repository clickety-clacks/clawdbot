import { type QaCliBackendAuthMode } from "./gateway-child.js";
import type { QaLabServerHandle, QaLabServerStartParams } from "./lab-server.types.js";
import { type QaProviderMode } from "./model-selection.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import { type QaTransportId } from "./qa-transport-registry.js";
import type { QaTransportState } from "./qa-transport.js";
import { type QaReportCheck } from "./report.js";
import { type QaBusMessage } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
export type QaSuiteScenarioResult = {
    name: string;
    status: "pass" | "fail";
    steps: QaReportCheck[];
    details?: string;
};
export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;
export type QaSuiteRunParams = {
    repoRoot?: string;
    outputDir?: string;
    providerMode?: QaProviderMode | "live-openai";
    transportId?: QaTransportId;
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    thinkingDefault?: QaThinkingLevel;
    claudeCliAuthMode?: QaCliBackendAuthMode;
    scenarioIds?: string[];
    lab?: QaLabServerHandle;
    startLab?: QaSuiteStartLabFn;
    concurrency?: number;
    controlUiEnabled?: boolean;
};
declare function normalizeQaSuiteConcurrency(value: number | undefined, scenarioCount: number): number;
declare function mapQaSuiteWithConcurrency<T, U>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<U>): Promise<U[]>;
declare function scenarioMatchesLiveLane(params: {
    scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
    primaryModel: string;
    providerMode: "mock-openai" | "live-frontier";
    claudeCliAuthMode?: QaCliBackendAuthMode;
}): boolean;
declare function selectQaSuiteScenarios(params: {
    scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
    scenarioIds?: string[];
    providerMode: "mock-openai" | "live-frontier";
    primaryModel: string;
    claudeCliAuthMode?: QaCliBackendAuthMode;
}): import("./scenario-catalog.js").QaSeedScenarioWithSource[];
declare function collectQaSuitePluginIds(scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"]): string[];
declare function collectQaSuiteGatewayConfigPatch(scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"]): Record<string, unknown> | undefined;
declare function collectQaSuiteGatewayRuntimeOptions(scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"]): {
    forwardHostHome: boolean;
} | undefined;
declare function scenarioRequiresControlUi(scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number]): boolean;
declare function resolveQaSuiteOutputDir(repoRoot: string, outputDir?: string): Promise<string>;
export type QaSuiteResult = {
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    report: string;
    scenarios: QaSuiteScenarioResult[];
    watchUrl: string;
};
declare function findFailureOutboundMessage(state: QaTransportState, options?: {
    sinceIndex?: number;
    cursorSpace?: "all" | "outbound";
}): import("@openclaw/qa-channel/test-api.ts").QaBusMessage | undefined;
declare function createScenarioWaitForCondition(state: QaTransportState): <T>(check: () => T | Promise<T | null | undefined> | null | undefined, timeoutMs?: number, intervalMs?: number) => Promise<T>;
declare function waitForOutboundMessage(state: QaTransportState, predicate: (message: QaBusMessage) => boolean, timeoutMs?: number, options?: {
    sinceIndex?: number;
}): Promise<import("@openclaw/qa-channel/test-api.ts").QaBusMessage>;
declare function readTransportTranscript(state: QaTransportState, params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
}): import("@openclaw/qa-channel/test-api.ts").QaBusMessage[];
declare function formatTransportTranscript(state: QaTransportState, params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
}): string;
declare function waitForTransportOutboundMessage(state: QaTransportState, predicate: (message: QaBusMessage) => boolean, timeoutMs?: number): Promise<import("@openclaw/qa-channel/test-api.ts").QaBusMessage>;
declare function waitForNoTransportOutbound(state: QaTransportState, timeoutMs?: number): Promise<void>;
declare function isConfigHashConflict(error: unknown): boolean;
declare function getGatewayRetryAfterMs(error: unknown): number | null;
export declare const qaSuiteTesting: {
    collectQaSuiteGatewayConfigPatch: typeof collectQaSuiteGatewayConfigPatch;
    collectQaSuiteGatewayRuntimeOptions: typeof collectQaSuiteGatewayRuntimeOptions;
    collectQaSuitePluginIds: typeof collectQaSuitePluginIds;
    createScenarioWaitForCondition: typeof createScenarioWaitForCondition;
    findFailureOutboundMessage: typeof findFailureOutboundMessage;
    getGatewayRetryAfterMs: typeof getGatewayRetryAfterMs;
    isConfigHashConflict: typeof isConfigHashConflict;
    mapQaSuiteWithConcurrency: typeof mapQaSuiteWithConcurrency;
    normalizeQaSuiteConcurrency: typeof normalizeQaSuiteConcurrency;
    scenarioMatchesLiveLane: typeof scenarioMatchesLiveLane;
    scenarioRequiresControlUi: typeof scenarioRequiresControlUi;
    selectQaSuiteScenarios: typeof selectQaSuiteScenarios;
    readTransportTranscript: typeof readTransportTranscript;
    formatTransportTranscript: typeof formatTransportTranscript;
    resolveQaSuiteOutputDir: typeof resolveQaSuiteOutputDir;
    waitForTransportOutboundMessage: typeof waitForTransportOutboundMessage;
    waitForNoTransportOutbound: typeof waitForNoTransportOutbound;
    waitForOutboundMessage: typeof waitForOutboundMessage;
};
export type QaSuiteSummaryJsonParams = {
    scenarios: QaSuiteScenarioResult[];
    startedAt: Date;
    finishedAt: Date;
    providerMode: QaProviderMode;
    primaryModel: string;
    alternateModel: string;
    fastMode: boolean;
    concurrency: number;
    scenarioIds?: readonly string[];
};
/**
 * Strongly-typed shape of `qa-suite-summary.json`. The GPT-5.4 parity gate
 * (agentic-parity-report.ts, #64441) and any future parity wrapper can
 * import this type instead of re-declaring the shape, so changes to the
 * summary schema propagate through to every consumer at type-check time.
 */
export type QaSuiteSummaryJson = {
    scenarios: QaSuiteScenarioResult[];
    counts: {
        total: number;
        passed: number;
        failed: number;
    };
    run: {
        startedAt: string;
        finishedAt: string;
        providerMode: QaProviderMode;
        primaryModel: string;
        primaryProvider: string | null;
        primaryModelName: string | null;
        alternateModel: string;
        alternateProvider: string | null;
        alternateModelName: string | null;
        fastMode: boolean;
        concurrency: number;
        scenarioIds: string[] | null;
    };
};
/**
 * Pure-ish JSON builder for qa-suite-summary.json. Exported so the GPT-5.4
 * parity gate (agentic-parity-report.ts, #64441) and any future parity
 * runner can assert-and-trust the provider/model that produced a given
 * summary instead of blindly accepting the caller's candidateLabel /
 * baselineLabel. Without the `run` block, a maintainer who swaps candidate
 * and baseline summary paths could silently produce a mislabeled verdict.
 *
 * `scenarioIds` is only recorded when the caller passed a non-empty array
 * (an explicit scenario selection). A missing or empty array means "no
 * filter, full lane-selected catalog", which the summary encodes as `null`
 * so parity/report tooling doesn't mistake a full run for an explicit
 * empty selection.
 */
export declare function buildQaSuiteSummaryJson(params: QaSuiteSummaryJsonParams): QaSuiteSummaryJson;
export declare function runQaSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult>;
export {};
