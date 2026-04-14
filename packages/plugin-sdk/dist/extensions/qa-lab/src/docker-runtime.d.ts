export type RunCommand = (command: string, args: string[], cwd: string) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type FetchLike = (input: string) => Promise<{
    ok: boolean;
}>;
export declare function fetchHealthUrl(url: string): Promise<{
    ok: boolean;
}>;
export declare function describeError(error: unknown): string;
export declare function resolveHostPort(preferredPort: number, pinned: boolean): Promise<number>;
export declare function execCommand(command: string, args: string[], cwd: string): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare function waitForHealth(url: string, deps: {
    label?: string;
    composeFile?: string;
    fetchImpl: FetchLike;
    sleepImpl: (ms: number) => Promise<unknown>;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<void>;
declare function normalizeDockerServiceStatus(row?: {
    Health?: string;
    State?: string;
}): string;
export declare function waitForDockerServiceHealth(service: string, composeFile: string, repoRoot: string, runCommand: RunCommand, sleepImpl: (ms: number) => Promise<unknown>, timeoutMs?: number, pollMs?: number): Promise<void>;
export declare function resolveComposeServiceUrl(service: string, port: number, composeFile: string, repoRoot: string, runCommand: RunCommand, fetchImpl?: FetchLike): Promise<string | null>;
export declare const __testing: {
    fetchHealthUrl: typeof fetchHealthUrl;
    normalizeDockerServiceStatus: typeof normalizeDockerServiceStatus;
};
export {};
