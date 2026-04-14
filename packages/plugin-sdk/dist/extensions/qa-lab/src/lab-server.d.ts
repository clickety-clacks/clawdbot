import type { QaLabServerHandle, QaLabServerStartParams } from "./lab-server.types.js";
export type { QaLabLatestReport, QaLabScenarioOutcome, QaLabScenarioRun, QaLabServerHandle, QaLabServerStartParams, } from "./lab-server.types.js";
export declare function startQaLabServer(params?: QaLabServerStartParams): Promise<QaLabServerHandle>;
