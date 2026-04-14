import type { QaTransportState } from "./qa-transport.js";
import type { QaScenarioFlow, QaSeedScenarioWithSource } from "./scenario-catalog.js";
type QaSuiteStep = {
    name: string;
    run: () => Promise<string | void>;
};
type QaSuiteScenarioResult = {
    name: string;
    status: "pass" | "fail";
    steps: Array<{
        name: string;
        status: "pass" | "fail" | "skip";
        details?: string;
    }>;
    details?: string;
};
type QaFlowApi = Record<string, unknown> & {
    state: QaTransportState;
    scenario: QaSeedScenarioWithSource;
    config: Record<string, unknown>;
    runScenario: (name: string, steps: QaSuiteStep[]) => Promise<QaSuiteScenarioResult>;
};
export declare function runScenarioFlow(params: {
    api: QaFlowApi;
    flow: QaScenarioFlow;
    scenarioTitle: string;
}): Promise<QaSuiteScenarioResult>;
export declare function describeScenarioFlowError(error: unknown): string;
export {};
