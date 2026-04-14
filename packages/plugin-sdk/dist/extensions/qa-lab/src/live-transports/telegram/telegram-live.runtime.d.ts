import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { type QaProviderModeInput } from "../../run-config.js";
import { type LiveTransportScenarioDefinition } from "../shared/live-transport-scenarios.js";
type TelegramQaRuntimeEnv = {
    groupId: string;
    driverToken: string;
    sutToken: string;
};
type TelegramQaScenarioId = "telegram-help-command" | "telegram-commands-command" | "telegram-tools-compact-command" | "telegram-whoami-command" | "telegram-context-command" | "telegram-mentioned-message-reply" | "telegram-mention-gating";
type TelegramQaScenarioRun = {
    expectReply: boolean;
    input: string;
    expectedTextIncludes?: string[];
    matchText?: string;
};
type TelegramQaScenarioDefinition = LiveTransportScenarioDefinition<TelegramQaScenarioId> & {
    buildRun: (sutUsername: string) => TelegramQaScenarioRun;
};
type TelegramObservedMessage = {
    updateId: number;
    messageId: number;
    chatId: number;
    senderId: number;
    senderIsBot: boolean;
    senderUsername?: string;
    text: string;
    caption?: string;
    replyToMessageId?: number;
    timestamp: number;
    inlineButtons: string[];
    mediaKinds: string[];
};
type TelegramObservedMessageArtifact = Omit<TelegramObservedMessage, "text" | "caption"> & {
    text?: string;
    caption?: string;
};
type TelegramQaScenarioResult = {
    id: string;
    title: string;
    status: "pass" | "fail";
    details: string;
};
export type TelegramQaRunResult = {
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    observedMessagesPath: string;
    scenarios: TelegramQaScenarioResult[];
};
type TelegramReplyMarkup = {
    inline_keyboard?: Array<Array<{
        text?: string;
    }>>;
};
type TelegramMessage = {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    reply_markup?: TelegramReplyMarkup;
    reply_to_message?: {
        message_id?: number;
    };
    from?: {
        id?: number;
        is_bot?: boolean;
        username?: string;
    };
    chat: {
        id: number;
    };
    photo?: unknown[];
    document?: unknown;
    audio?: unknown;
    video?: unknown;
    voice?: unknown;
    sticker?: unknown;
};
type TelegramUpdate = {
    update_id: number;
    message?: TelegramMessage;
};
export declare const TELEGRAM_QA_STANDARD_SCENARIO_IDS: import("../shared/live-transport-scenarios.js").LiveTransportStandardScenarioId[];
export declare function resolveTelegramQaRuntimeEnv(env?: NodeJS.ProcessEnv): TelegramQaRuntimeEnv;
declare function parseTelegramQaCredentialPayload(payload: unknown): TelegramQaRuntimeEnv;
export declare function normalizeTelegramObservedMessage(update: TelegramUpdate): TelegramObservedMessage | null;
declare function buildTelegramQaConfig(baseCfg: OpenClawConfig, params: {
    groupId: string;
    sutToken: string;
    driverBotId: number;
    sutAccountId: string;
}): OpenClawConfig;
declare function callTelegramApi<T>(token: string, method: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
declare function buildObservedMessagesArtifact(params: {
    observedMessages: TelegramObservedMessage[];
    includeContent: boolean;
}): TelegramObservedMessageArtifact[];
declare function findScenario(ids?: string[]): TelegramQaScenarioDefinition[];
declare function matchesTelegramScenarioReply(params: {
    groupId: string;
    matchText?: string;
    message: TelegramObservedMessage;
    sentMessageId: number;
    sutBotId: number;
}): boolean;
declare function assertTelegramScenarioReply(params: {
    expectedTextIncludes?: string[];
    message: TelegramObservedMessage;
}): void;
declare function classifyCanaryReply(params: {
    message: TelegramObservedMessage;
    groupId: string;
    sutBotId: number;
    driverMessageId: number;
}): "ignore" | "match" | "unthreaded";
declare function canaryFailureMessage(params: {
    error: unknown;
    groupId: string;
    driverBotId: number;
    driverUsername?: string;
    sutBotId: number;
    sutUsername: string;
}): string;
export declare function runTelegramQaLive(params: {
    repoRoot?: string;
    outputDir?: string;
    providerMode?: QaProviderModeInput;
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    scenarioIds?: string[];
    sutAccountId?: string;
    credentialSource?: string;
    credentialRole?: string;
}): Promise<TelegramQaRunResult>;
export declare const __testing: {
    TELEGRAM_QA_SCENARIOS: TelegramQaScenarioDefinition[];
    TELEGRAM_QA_STANDARD_SCENARIO_IDS: import("../shared/live-transport-scenarios.js").LiveTransportStandardScenarioId[];
    buildTelegramQaConfig: typeof buildTelegramQaConfig;
    buildObservedMessagesArtifact: typeof buildObservedMessagesArtifact;
    canaryFailureMessage: typeof canaryFailureMessage;
    callTelegramApi: typeof callTelegramApi;
    assertTelegramScenarioReply: typeof assertTelegramScenarioReply;
    classifyCanaryReply: typeof classifyCanaryReply;
    findScenario: typeof findScenario;
    matchesTelegramScenarioReply: typeof matchesTelegramScenarioReply;
    normalizeTelegramObservedMessage: typeof normalizeTelegramObservedMessage;
    parseTelegramQaCredentialPayload: typeof parseTelegramQaCredentialPayload;
    resolveTelegramQaRuntimeEnv: typeof resolveTelegramQaRuntimeEnv;
};
export {};
