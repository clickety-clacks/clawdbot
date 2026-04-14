type QaLiveTimeoutProfile = {
    providerMode: "mock-openai" | "live-frontier";
    primaryModel: string;
    alternateModel: string;
};
export declare function resolveQaLiveTurnTimeoutMs(profile: QaLiveTimeoutProfile, fallbackMs: number, modelRef?: string): number;
export {};
