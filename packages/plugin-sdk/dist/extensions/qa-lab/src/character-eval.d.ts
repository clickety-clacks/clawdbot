import { type QaProviderMode } from "./model-selection.js";
import { type QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaSuiteResult } from "./suite.js";
type QaCharacterRunStatus = "pass" | "fail";
export type QaCharacterModelOptions = {
    thinkingDefault?: QaThinkingLevel;
    fastMode?: boolean;
};
export type QaCharacterEvalRun = {
    model: string;
    status: QaCharacterRunStatus;
    durationMs: number;
    outputDir: string;
    thinkingDefault: QaThinkingLevel;
    fastMode: boolean;
    reportPath?: string;
    summaryPath?: string;
    transcript: string;
    stats: {
        transcriptChars: number;
        transcriptLines: number;
        userTurns: number;
        assistantTurns: number;
    };
    error?: string;
};
export type QaCharacterEvalJudgment = {
    model: string;
    rank: number;
    score: number;
    summary: string;
    strengths: string[];
    weaknesses: string[];
};
export type QaCharacterEvalResult = {
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    runs: QaCharacterEvalRun[];
    judgments: QaCharacterEvalJudgeResult[];
};
export type QaCharacterEvalJudgeResult = {
    model: string;
    thinkingDefault: QaThinkingLevel;
    fastMode: boolean;
    blindModels: boolean;
    timeoutMs: number;
    durationMs: number;
    rankings: QaCharacterEvalJudgment[];
    error?: string;
};
type QaCharacterEvalProgressLogger = (message: string) => void;
type RunSuiteFn = (params: {
    repoRoot: string;
    outputDir: string;
    providerMode: QaProviderMode;
    primaryModel: string;
    alternateModel: string;
    fastMode?: boolean;
    thinkingDefault?: QaThinkingLevel;
    scenarioIds: string[];
}) => Promise<QaSuiteResult>;
type RunJudgeFn = (params: {
    repoRoot: string;
    judgeModel: string;
    judgeThinkingDefault: QaThinkingLevel;
    judgeFastMode: boolean;
    prompt: string;
    timeoutMs: number;
}) => Promise<string | null>;
export type QaCharacterEvalParams = {
    repoRoot?: string;
    outputDir?: string;
    models: string[];
    scenarioId?: string;
    candidateFastMode?: boolean;
    candidateThinkingDefault?: QaThinkingLevel;
    candidateThinkingByModel?: Record<string, QaThinkingLevel>;
    candidateModelOptions?: Record<string, QaCharacterModelOptions>;
    judgeModel?: string;
    judgeModels?: string[];
    judgeThinkingDefault?: QaThinkingLevel;
    judgeModelOptions?: Record<string, QaCharacterModelOptions>;
    judgeTimeoutMs?: number;
    judgeBlindModels?: boolean;
    candidateConcurrency?: number;
    judgeConcurrency?: number;
    runSuite?: RunSuiteFn;
    runJudge?: RunJudgeFn;
    progress?: QaCharacterEvalProgressLogger;
};
export declare function runQaCharacterEval(params: QaCharacterEvalParams): Promise<{
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    runs: ({
        error?: string | undefined;
        model: string;
        status: "pass" | "fail";
        durationMs: number;
        outputDir: string;
        thinkingDefault: QaThinkingLevel;
        fastMode: boolean;
        reportPath: string;
        summaryPath: string;
        transcript: string;
        stats: {
            transcriptChars: number;
            transcriptLines: number;
            userTurns: number;
            assistantTurns: number;
        };
    } | {
        model: string;
        status: "fail";
        durationMs: number;
        outputDir: string;
        thinkingDefault: QaThinkingLevel;
        fastMode: boolean;
        transcript: string;
        stats: {
            transcriptChars: number;
            transcriptLines: number;
            userTurns: number;
            assistantTurns: number;
        };
        error: string;
    })[];
    judgments: {
        error?: string | undefined;
        model: string;
        thinkingDefault: QaThinkingLevel;
        fastMode: boolean;
        blindModels: boolean;
        timeoutMs: number;
        durationMs: number;
        rankings: QaCharacterEvalJudgment[];
    }[];
}>;
export {};
