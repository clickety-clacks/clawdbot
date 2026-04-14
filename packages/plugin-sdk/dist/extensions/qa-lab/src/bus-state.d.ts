import type { QaBusCreateThreadInput, QaBusDeleteMessageInput, QaBusEditMessageInput, QaBusInboundMessageInput, QaBusOutboundMessageInput, QaBusPollInput, QaBusReadMessageInput, QaBusReactToMessageInput, QaBusSearchMessagesInput, QaBusWaitForInput } from "./runtime-api.js";
export declare function createQaBusState(): {
    reset(): void;
    getSnapshot(): import("@openclaw/qa-channel/test-api.ts").QaBusStateSnapshot;
    addInboundMessage(input: QaBusInboundMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    addOutboundMessage(input: QaBusOutboundMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    createThread(input: QaBusCreateThreadInput): {
        id: string;
        accountId: string;
        conversationId: string;
        title: string;
        createdAt: number;
        createdBy: string;
    };
    reactToMessage(input: QaBusReactToMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    editMessage(input: QaBusEditMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    deleteMessage(input: QaBusDeleteMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    readMessage(input: QaBusReadMessageInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage;
    searchMessages(input: QaBusSearchMessagesInput): import("@openclaw/qa-channel/test-api.ts").QaBusMessage[];
    poll(input?: QaBusPollInput): import("@openclaw/qa-channel/test-api.ts").QaBusPollResult;
    waitFor(input: QaBusWaitForInput): Promise<import("./bus-waiters.js").QaBusWaitMatch>;
};
export type QaBusState = ReturnType<typeof createQaBusState>;
