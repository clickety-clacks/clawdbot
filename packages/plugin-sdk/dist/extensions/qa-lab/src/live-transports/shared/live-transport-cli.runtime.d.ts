import type { QaProviderMode } from "../../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";
export declare function resolveLiveTransportQaRunOptions(opts: LiveTransportQaCommandOptions): LiveTransportQaCommandOptions & {
    repoRoot: string;
    providerMode: QaProviderMode;
};
export declare function printLiveTransportQaArtifacts(laneLabel: string, artifacts: Record<string, string>): void;
