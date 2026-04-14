import type { QaBusConversation, QaBusEvent, QaBusMessage, QaBusPollInput, QaBusPollResult, QaBusReadMessageInput, QaBusSearchMessagesInput, QaBusStateSnapshot, QaBusThread } from "./runtime-api.js";
export declare const DEFAULT_ACCOUNT_ID = "default";
export declare function normalizeAccountId(raw?: string): string;
export declare function normalizeConversationFromTarget(target: string): {
    conversation: QaBusConversation;
    threadId?: string;
};
export declare function cloneMessage(message: QaBusMessage): QaBusMessage;
export declare function cloneEvent(event: QaBusEvent): QaBusEvent;
export declare function buildQaBusSnapshot(params: {
    cursor: number;
    conversations: Map<string, QaBusConversation>;
    threads: Map<string, QaBusThread>;
    messages: Map<string, QaBusMessage>;
    events: QaBusEvent[];
}): QaBusStateSnapshot;
export declare function readQaBusMessage(params: {
    messages: Map<string, QaBusMessage>;
    input: QaBusReadMessageInput;
}): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
export declare function searchQaBusMessages(params: {
    messages: Map<string, QaBusMessage>;
    input: QaBusSearchMessagesInput;
}): import("@openclaw/qa-channel/test-api.ts").QaBusMessage[];
export declare function pollQaBusEvents(params: {
    events: QaBusEvent[];
    cursor: number;
    input?: QaBusPollInput;
}): QaBusPollResult;
