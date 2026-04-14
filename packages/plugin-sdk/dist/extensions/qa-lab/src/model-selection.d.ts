export type QaProviderMode = "mock-openai" | "live-frontier";
export type QaProviderModeInput = QaProviderMode | "live-openai";
export type QaModelSelection = {
    primaryModel: string;
    alternateModel: string;
};
export declare function normalizeQaProviderMode(mode: QaProviderModeInput): QaProviderMode;
export declare function defaultQaModelForMode(mode: QaProviderModeInput, options?: {
    alternate?: boolean;
    preferredLiveModel?: string;
}): string;
export declare function splitQaModelRef(ref: string): {
    provider: string;
    model: string;
} | null;
export declare function isQaFastModeModelRef(ref: string): boolean;
export declare function isQaFastModeEnabled(selection: QaModelSelection): boolean;
