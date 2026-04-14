import type { QaBusState } from "./bus-state.js";
import type { QaTransportAdapter } from "./qa-transport.js";
export type QaTransportId = "qa-channel";
export declare function normalizeQaTransportId(input?: string | null): QaTransportId;
export declare function createQaTransportAdapter(params: {
    id: QaTransportId;
    state: QaBusState;
}): QaTransportAdapter;
