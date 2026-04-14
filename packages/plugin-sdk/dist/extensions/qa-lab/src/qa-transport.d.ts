import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaBusInboundMessageInput, QaBusMessage, QaBusOutboundMessageInput, QaBusSearchMessagesInput, QaBusReadMessageInput, QaBusStateSnapshot, QaBusWaitForInput } from "./runtime-api.js";
export type QaTransportGatewayClient = {
    call: (method: string, params?: unknown, options?: {
        timeoutMs?: number;
    }) => Promise<unknown>;
};
export type QaTransportActionName = "delete" | "edit" | "react" | "thread-create";
export type QaTransportReportParams = {
    providerMode: "mock-openai" | "live-frontier";
    primaryModel: string;
    alternateModel: string;
    fastMode: boolean;
    concurrency: number;
};
export type QaTransportGatewayConfig = Pick<OpenClawConfig, "channels" | "messages">;
export type QaTransportState = {
    reset: () => void | Promise<void>;
    getSnapshot: () => QaBusStateSnapshot;
    addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
    addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
    readMessage: (input: QaBusReadMessageInput) => QaBusMessage | null | undefined | Promise<QaBusMessage | null | undefined>;
    searchMessages: (input: QaBusSearchMessagesInput) => QaBusMessage[] | Promise<QaBusMessage[]>;
    waitFor: (input: QaBusWaitForInput) => Promise<unknown>;
};
export type QaTransportFailureCursorSpace = "all" | "outbound";
export type QaTransportFailureAssertionOptions = {
    sinceIndex?: number;
    cursorSpace?: QaTransportFailureCursorSpace;
};
export type QaTransportCommonCapabilities = {
    sendInboundMessage: QaTransportState["addInboundMessage"];
    injectOutboundMessage: QaTransportState["addOutboundMessage"];
    waitForOutboundMessage: (input: QaBusWaitForInput) => Promise<unknown>;
    getNormalizedMessageState: () => QaBusStateSnapshot;
    resetNormalizedMessageState: () => Promise<void>;
    readNormalizedMessage: QaTransportState["readMessage"];
    executeGenericAction: (params: {
        action: QaTransportActionName;
        args: Record<string, unknown>;
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Promise<unknown>;
    waitForReady: (params: {
        gateway: QaTransportGatewayClient;
        timeoutMs?: number;
    }) => Promise<void>;
    waitForCondition: <T>(check: () => T | Promise<T | null | undefined> | null | undefined, timeoutMs?: number, intervalMs?: number) => Promise<T>;
    assertNoFailureReplies: (options?: QaTransportFailureAssertionOptions) => void;
};
export declare function waitForQaTransportCondition<T>(check: () => T | Promise<T | null | undefined> | null | undefined, timeoutMs?: number, intervalMs?: number): Promise<T>;
export declare function findFailureOutboundMessage(state: QaTransportState, options?: QaTransportFailureAssertionOptions): import("@openclaw/qa-channel/test-api.ts").QaBusMessage | undefined;
export declare function assertNoFailureReplies(state: QaTransportState, options?: QaTransportFailureAssertionOptions): void;
export declare function createFailureAwareTransportWaitForCondition(state: QaTransportState): <T>(check: () => T | Promise<T | null | undefined> | null | undefined, timeoutMs?: number, intervalMs?: number) => Promise<T>;
export type QaTransportAdapter = {
    id: string;
    label: string;
    accountId: string;
    requiredPluginIds: readonly string[];
    state: QaTransportState;
    capabilities: QaTransportCommonCapabilities;
    createGatewayConfig: (params: {
        baseUrl: string;
    }) => QaTransportGatewayConfig;
    waitReady: (params: {
        gateway: QaTransportGatewayClient;
        timeoutMs?: number;
    }) => Promise<void>;
    buildAgentDelivery: (params: {
        target: string;
    }) => {
        channel: string;
        replyChannel: string;
        replyTo: string;
    };
    handleAction: (params: {
        action: QaTransportActionName;
        args: Record<string, unknown>;
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Promise<unknown>;
    createReportNotes: (params: QaTransportReportParams) => string[];
};
export declare abstract class QaStateBackedTransportAdapter implements QaTransportAdapter {
    readonly id: string;
    readonly label: string;
    readonly accountId: string;
    readonly requiredPluginIds: readonly string[];
    readonly state: QaTransportState;
    readonly capabilities: QaTransportCommonCapabilities;
    protected constructor(params: {
        id: string;
        label: string;
        accountId: string;
        requiredPluginIds: readonly string[];
        state: QaTransportState;
    });
    abstract createGatewayConfig: (params: {
        baseUrl: string;
    }) => QaTransportGatewayConfig;
    abstract waitReady: (params: {
        gateway: QaTransportGatewayClient;
        timeoutMs?: number;
    }) => Promise<void>;
    abstract buildAgentDelivery: (params: {
        target: string;
    }) => {
        channel: string;
        replyChannel: string;
        replyTo: string;
    };
    abstract handleAction: (params: {
        action: QaTransportActionName;
        args: Record<string, unknown>;
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => Promise<unknown>;
    abstract createReportNotes: (params: QaTransportReportParams) => string[];
}
