export type LiveTransportStandardScenarioId = "canary" | "mention-gating" | "allowlist-block" | "top-level-reply-shape" | "restart-resume" | "thread-follow-up" | "thread-isolation" | "reaction-observation" | "help-command";
export type LiveTransportScenarioDefinition<TId extends string = string> = {
    id: TId;
    standardId?: LiveTransportStandardScenarioId;
    timeoutMs: number;
    title: string;
};
export type LiveTransportStandardScenarioDefinition = {
    description: string;
    id: LiveTransportStandardScenarioId;
    title: string;
};
export declare const LIVE_TRANSPORT_STANDARD_SCENARIOS: readonly LiveTransportStandardScenarioDefinition[];
export declare const LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS: readonly LiveTransportStandardScenarioId[];
export declare function selectLiveTransportScenarios<TDefinition extends {
    id: string;
}>(params: {
    ids?: string[];
    laneLabel: string;
    scenarios: readonly TDefinition[];
}): TDefinition[];
export declare function collectLiveTransportStandardScenarioCoverage<TId extends string>(params: {
    alwaysOnStandardScenarioIds?: readonly LiveTransportStandardScenarioId[];
    scenarios: readonly LiveTransportScenarioDefinition<TId>[];
}): LiveTransportStandardScenarioId[];
export declare function findMissingLiveTransportStandardScenarios(params: {
    coveredStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
    expectedStandardScenarioIds: readonly LiveTransportStandardScenarioId[];
}): LiveTransportStandardScenarioId[];
