import { type QaProviderModeInput } from "./model-selection.js";
export declare function resolveQaPreferredLiveModel(): "openai-codex/gpt-5.4" | undefined;
export declare function defaultQaRuntimeModelForMode(mode: QaProviderModeInput, options?: {
    alternate?: boolean;
    preferredLiveModel?: string;
}): string;
