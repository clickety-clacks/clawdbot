import type { QaTransportActionName, QaTransportState } from "./qa-transport.js";
export type QaScenarioStepContext = {
    state: QaTransportState;
    performAction?: (action: QaTransportActionName, args: Record<string, unknown>) => Promise<unknown>;
};
export type QaScenarioStep = {
    name: string;
    run: (ctx: QaScenarioStepContext) => Promise<string | void>;
};
export type QaScenarioDefinition = {
    name: string;
    steps: QaScenarioStep[];
};
export type QaScenarioStepResult = {
    name: string;
    status: "pass" | "fail";
    details?: string;
};
export type QaScenarioResult = {
    name: string;
    status: "pass" | "fail";
    steps: QaScenarioStepResult[];
    details?: string;
};
export declare function runQaScenario(definition: QaScenarioDefinition, ctx: QaScenarioStepContext): Promise<QaScenarioResult>;
