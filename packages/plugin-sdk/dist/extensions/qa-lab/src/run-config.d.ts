import { type QaProviderMode } from "./model-selection.js";
import type { QaSeedScenario } from "./scenario-catalog.js";
export type { QaProviderMode } from "./model-selection.js";
export type QaProviderModeInput = QaProviderMode | "live-openai";
export type QaLabRunSelection = {
    providerMode: QaProviderMode;
    primaryModel: string;
    alternateModel: string;
    fastMode: boolean;
    scenarioIds: string[];
};
export type QaLabRunArtifacts = {
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    watchUrl: string;
};
export type QaLabRunnerSnapshot = {
    status: "idle" | "running" | "completed" | "failed";
    selection: QaLabRunSelection;
    startedAt?: string;
    finishedAt?: string;
    artifacts: QaLabRunArtifacts | null;
    error: string | null;
};
export declare function defaultQaModelForMode(mode: QaProviderMode, alternate?: boolean): string;
export declare function createDefaultQaRunSelection(scenarios: QaSeedScenario[]): QaLabRunSelection;
export declare function normalizeQaProviderMode(input: unknown): QaProviderMode;
export declare function normalizeQaRunSelection(input: unknown, scenarios: QaSeedScenario[]): QaLabRunSelection;
export declare function createIdleQaRunnerSnapshot(scenarios: QaSeedScenario[]): QaLabRunnerSnapshot;
export declare function createQaRunOutputDir(baseDir?: string): string;
