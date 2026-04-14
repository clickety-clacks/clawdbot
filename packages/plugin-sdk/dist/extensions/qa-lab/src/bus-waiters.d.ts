import type { QaBusEvent, QaBusMessage, QaBusStateSnapshot, QaBusThread, QaBusWaitForInput } from "./runtime-api.js";
export declare const DEFAULT_WAIT_TIMEOUT_MS = 5000;
export type QaBusWaitMatch = QaBusEvent | QaBusMessage | QaBusThread;
export declare function createQaBusWaiterStore(getSnapshot: () => QaBusStateSnapshot): {
    reset(reason?: string): void;
    settle(): void;
    waitFor(input: QaBusWaitForInput): Promise<QaBusWaitMatch>;
};
