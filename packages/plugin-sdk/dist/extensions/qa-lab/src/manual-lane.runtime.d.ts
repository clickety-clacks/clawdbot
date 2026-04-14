import type { QaThinkingLevel } from "./qa-gateway-config.js";
import { type QaTransportId } from "./qa-transport-registry.js";
type QaManualLaneParams = {
    repoRoot: string;
    transportId?: QaTransportId;
    providerMode: "mock-openai" | "live-frontier";
    primaryModel: string;
    alternateModel: string;
    fastMode?: boolean;
    thinkingDefault?: QaThinkingLevel;
    message: string;
    timeoutMs?: number;
};
export declare function runQaManualLane(params: QaManualLaneParams): Promise<{
    model: string;
    waited: {
        status?: string;
        error?: string;
    };
    reply: string | null;
    watchUrl: string;
}>;
export {};
