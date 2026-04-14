import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaBusState } from "./bus-state.js";
import { QaStateBackedTransportAdapter } from "./qa-transport.js";
import type { QaTransportActionName, QaTransportGatewayConfig, QaTransportGatewayClient, QaTransportReportParams } from "./qa-transport.js";
export declare const QA_CHANNEL_ID = "qa-channel";
export declare const QA_CHANNEL_ACCOUNT_ID = "default";
export declare const QA_CHANNEL_REQUIRED_PLUGIN_IDS: readonly string[];
declare function waitForQaChannelReady(params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
}): Promise<void>;
export declare function createQaChannelGatewayConfig(params: {
    baseUrl: string;
}): QaTransportGatewayConfig;
declare function createQaChannelReportNotes(params: QaTransportReportParams): string[];
declare function handleQaChannelAction(params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
}): Promise<import("@mariozechner/pi-agent-core").AgentToolResult<unknown> | undefined>;
declare class QaChannelTransport extends QaStateBackedTransportAdapter {
    constructor(state: QaBusState);
    createGatewayConfig: typeof createQaChannelGatewayConfig;
    waitReady: typeof waitForQaChannelReady;
    buildAgentDelivery: ({ target }: {
        target: string;
    }) => {
        channel: string;
        replyChannel: string;
        replyTo: string;
    };
    handleAction: typeof handleQaChannelAction;
    createReportNotes: typeof createQaChannelReportNotes;
}
export declare function createQaChannelTransport(state: QaBusState): QaChannelTransport;
export {};
