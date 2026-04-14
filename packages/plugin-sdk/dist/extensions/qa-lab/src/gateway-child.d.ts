import { type ChildProcess } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import { type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapter } from "./qa-transport.js";
export type QaCliBackendAuthMode = "auto" | "api-key" | "subscription";
declare function assertQaArtifactDirWithinRepo(repoRoot: string, artifactDir: string): Promise<string>;
declare function cleanupQaGatewayTempRoots(params: {
    tempRoot: string;
    stagedBundledPluginsRoot?: string | null;
}): Promise<void>;
declare function preserveQaGatewayDebugArtifacts(params: {
    preserveToDir: string;
    stdoutLogPath: string;
    stderrLogPath: string;
    tempRoot: string;
    repoRoot?: string;
}): Promise<void>;
declare function isRetryableGatewayStartupError(details: string): boolean;
export declare function normalizeQaProviderModeEnv(env: NodeJS.ProcessEnv, providerMode?: "mock-openai" | "live-frontier"): NodeJS.ProcessEnv;
export declare function resolveQaGatewayChildProviderMode(providerMode?: "mock-openai" | "live-frontier"): "mock-openai" | "live-frontier";
declare function resolveQaLiveCliAuthEnv(baseEnv: NodeJS.ProcessEnv, opts?: {
    forwardHostHomeForClaudeCli?: boolean;
    claudeCliAuthMode?: QaCliBackendAuthMode;
}): {
    HOME?: string | undefined;
    CODEX_HOME?: string | undefined;
};
export declare function buildQaRuntimeEnv(params: {
    configPath: string;
    gatewayToken: string;
    homeDir: string;
    forwardHostHome?: boolean;
    stateDir: string;
    xdgConfigHome: string;
    xdgDataHome: string;
    xdgCacheHome: string;
    bundledPluginsDir?: string;
    compatibilityHostVersion?: string;
    providerMode?: "mock-openai" | "live-frontier";
    baseEnv?: NodeJS.ProcessEnv;
    forwardHostHomeForClaudeCli?: boolean;
    claudeCliAuthMode?: QaCliBackendAuthMode;
}): NodeJS.ProcessEnv;
declare function resolveQaLiveAnthropicSetupToken(env?: NodeJS.ProcessEnv): {
    token: string;
    profileId: string;
} | null;
export declare function stageQaLiveAnthropicSetupToken(params: {
    cfg: OpenClawConfig;
    stateDir: string;
    env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig>;
/** Providers the mock-openai harness stages placeholder credentials for. */
export declare const QA_MOCK_AUTH_PROVIDERS: readonly ["openai", "anthropic"];
/** Agent IDs the mock-openai harness stages credentials under. */
export declare const QA_MOCK_AUTH_AGENT_IDS: readonly ["main", "qa"];
export declare function buildQaMockProfileId(provider: string): string;
/**
 * In mock-openai mode the qa suite runs against the embedded mock server
 * instead of a real provider API. The mock does not validate credentials, but
 * the agent auth layer still needs a matching `api_key` auth profile in
 * `auth-profiles.json` before it will route the request through
 * `providerBaseUrl`. Without this staging step, every scenario fails with
 * `FailoverError: No API key found for provider "openai"` before the mock
 * server ever sees a request.
 *
 * Stages a placeholder `api_key` profile per provider in each of the agent
 * dirs the qa suite uses (`main` for the runtime config, `qa` for scenario
 * runs) and returns a config with matching `auth.profiles` entries so the
 * runtime accepts the profile on the first lookup.
 *
 * The placeholder value `qa-mock-not-a-real-key` is intentionally not
 * shaped like a real API key (no `sk-` prefix that would trip secret
 * scanners). It only needs to be non-empty to pass the credential
 * serializer; anything beyond that is ignored by the mock.
 */
export declare function stageQaMockAuthProfiles(params: {
    cfg: OpenClawConfig;
    stateDir: string;
    agentIds?: readonly string[];
    providers?: readonly string[];
}): Promise<OpenClawConfig>;
declare function isRetryableGatewayCallError(details: string): boolean;
declare function fetchLocalGatewayHealth(params: {
    baseUrl: string;
    healthPath: "/readyz" | "/healthz";
}): Promise<boolean>;
export declare const __testing: {
    assertQaArtifactDirWithinRepo: typeof assertQaArtifactDirWithinRepo;
    buildQaRuntimeEnv: typeof buildQaRuntimeEnv;
    cleanupQaGatewayTempRoots: typeof cleanupQaGatewayTempRoots;
    fetchLocalGatewayHealth: typeof fetchLocalGatewayHealth;
    isRetryableGatewayCallError: typeof isRetryableGatewayCallError;
    isRetryableRpcStartupError: typeof isRetryableRpcStartupError;
    isRetryableGatewayStartupError: typeof isRetryableGatewayStartupError;
    preserveQaGatewayDebugArtifacts: typeof preserveQaGatewayDebugArtifacts;
    redactQaGatewayDebugText: typeof redactQaGatewayDebugText;
    readQaLiveProviderConfigOverrides: typeof readQaLiveProviderConfigOverrides;
    resolveQaGatewayChildProviderMode: typeof resolveQaGatewayChildProviderMode;
    resolveQaLiveAnthropicSetupToken: typeof resolveQaLiveAnthropicSetupToken;
    stageQaLiveAnthropicSetupToken: typeof stageQaLiveAnthropicSetupToken;
    stageQaMockAuthProfiles: typeof stageQaMockAuthProfiles;
    resolveQaLiveCliAuthEnv: typeof resolveQaLiveCliAuthEnv;
    resolveQaOwnerPluginIdsForProviderIds: typeof resolveQaOwnerPluginIdsForProviderIds;
    resolveQaBundledPluginsSourceRoot: typeof resolveQaBundledPluginsSourceRoot;
    resolveQaRuntimeHostVersion: typeof resolveQaRuntimeHostVersion;
    createQaBundledPluginsDir: typeof createQaBundledPluginsDir;
    stopQaGatewayChildProcessTree: typeof stopQaGatewayChildProcessTree;
};
declare function stopQaGatewayChildProcessTree(child: ChildProcess, opts?: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
}): Promise<void>;
declare function resolveQaBundledPluginsSourceRoot(repoRoot: string): string;
declare function resolveQaOwnerPluginIdsForProviderIds(params: {
    repoRoot: string;
    providerIds: readonly string[];
    providerConfigs?: Record<string, ModelProviderConfig>;
}): Promise<string[]>;
declare function readQaLiveProviderConfigOverrides(params: {
    providerIds: readonly string[];
    env?: NodeJS.ProcessEnv;
}): Promise<Record<string, ModelProviderConfig>>;
declare function resolveQaRuntimeHostVersion(params: {
    repoRoot: string;
    bundledPluginsSourceRoot: string;
    allowedPluginIds: readonly string[];
}): Promise<string | undefined>;
declare function createQaBundledPluginsDir(params: {
    repoRoot: string;
    tempRoot: string;
    allowedPluginIds: readonly string[];
}): Promise<{
    bundledPluginsDir: string;
    stagedRoot: string;
} | {
    bundledPluginsDir: string;
    stagedRoot: null;
}>;
declare function isRetryableRpcStartupError(error: unknown): boolean;
export declare function resolveQaControlUiRoot(params: {
    repoRoot: string;
    controlUiEnabled?: boolean;
}): string | undefined;
export declare function startQaGatewayChild(params: {
    repoRoot: string;
    providerBaseUrl?: string;
    transport: Pick<QaTransportAdapter, "requiredPluginIds" | "createGatewayConfig">;
    transportBaseUrl: string;
    controlUiAllowedOrigins?: string[];
    providerMode?: "mock-openai" | "live-frontier";
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    thinkingDefault?: QaThinkingLevel;
    claudeCliAuthMode?: QaCliBackendAuthMode;
    controlUiEnabled?: boolean;
    enabledPluginIds?: string[];
    forwardHostHome?: boolean;
    mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<{
    cfg: OpenClawConfig;
    baseUrl: string;
    wsUrl: string;
    pid: number | null;
    token: string;
    workspaceDir: string;
    tempRoot: string;
    configPath: string;
    runtimeEnv: NodeJS.ProcessEnv;
    logs: () => string;
    restart(signal?: NodeJS.Signals): Promise<void>;
    call(method: string, rpcParams?: unknown, opts?: {
        expectFinal?: boolean;
        timeoutMs?: number;
    }): Promise<unknown>;
    stop(opts?: {
        keepTemp?: boolean;
        preserveToDir?: string;
    }): Promise<void>;
}>;
export {};
