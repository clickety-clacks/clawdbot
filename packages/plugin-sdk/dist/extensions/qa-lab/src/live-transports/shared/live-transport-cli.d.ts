import type { Command } from "commander";
import type { QaProviderModeInput } from "../../run-config.js";
export type LiveTransportQaCommandOptions = {
    repoRoot?: string;
    outputDir?: string;
    providerMode?: QaProviderModeInput;
    primaryModel?: string;
    alternateModel?: string;
    fastMode?: boolean;
    scenarioIds?: string[];
    sutAccountId?: string;
    credentialSource?: string;
    credentialRole?: string;
};
type LiveTransportQaCommanderOptions = {
    repoRoot?: string;
    outputDir?: string;
    providerMode?: QaProviderModeInput;
    model?: string;
    altModel?: string;
    scenario?: string[];
    fast?: boolean;
    sutAccount?: string;
    credentialSource?: string;
    credentialRole?: string;
};
export type LiveTransportQaCliRegistration = {
    commandName: string;
    register(qa: Command): void;
};
export declare function createLazyCliRuntimeLoader<T>(load: () => Promise<T>): () => Promise<T>;
export declare function mapLiveTransportQaCommanderOptions(opts: LiveTransportQaCommanderOptions): LiveTransportQaCommandOptions;
export declare function registerLiveTransportQaCli(params: {
    qa: Command;
    commandName: string;
    description: string;
    outputDirHelp: string;
    scenarioHelp: string;
    sutAccountHelp: string;
    run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
}): void;
export declare function createLiveTransportQaCliRegistration(params: {
    commandName: string;
    description: string;
    outputDirHelp: string;
    scenarioHelp: string;
    sutAccountHelp: string;
    run: (opts: LiveTransportQaCommandOptions) => Promise<void>;
}): LiveTransportQaCliRegistration;
export {};
