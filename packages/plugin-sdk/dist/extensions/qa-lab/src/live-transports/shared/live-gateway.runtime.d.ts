import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { type QaCliBackendAuthMode } from "../../gateway-child.js";
import type { QaThinkingLevel } from "../../qa-gateway-config.js";
export declare function startQaLiveLaneGateway(params: {
    repoRoot: string;
    transport: {
        requiredPluginIds: readonly string[];
        createGatewayConfig: (params: {
            baseUrl: string;
        }) => Pick<OpenClawConfig, "channels" | "messages">;
    };
    transportBaseUrl: string;
    controlUiAllowedOrigins?: string[];
    providerMode: "mock-openai" | "live-frontier";
    primaryModel: string;
    alternateModel: string;
    fastMode?: boolean;
    thinkingDefault?: QaThinkingLevel;
    claudeCliAuthMode?: QaCliBackendAuthMode;
    controlUiEnabled?: boolean;
    mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<{
    gateway: {
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
    };
    mock: {
        baseUrl: string;
        stop(): Promise<void>;
    } | null;
    stop(): Promise<void>;
}>;
