import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaBusState } from "./bus-state.js";
import { type QaTransportId } from "./qa-transport-registry.js";
import { type QaScenarioResult } from "./scenario.js";
export type QaSelfCheckResult = {
    outputPath: string;
    report: string;
    checks: Array<{
        name: string;
        status: "pass" | "fail";
        details?: string;
    }>;
    scenarioResult: QaScenarioResult;
};
export declare function resolveQaSelfCheckOutputPath(params?: {
    outputPath?: string;
    repoRoot?: string;
}): string;
export declare function runQaSelfCheckAgainstState(params: {
    state: QaBusState;
    cfg: OpenClawConfig;
    transportId?: QaTransportId;
    outputPath?: string;
    repoRoot?: string;
    notes?: string[];
}): Promise<QaSelfCheckResult>;
