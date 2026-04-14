type ConvexCredentialBrokerConfig = {
    acquireTimeoutMs: number;
    acquireUrl: string;
    authToken: string;
    heartbeatIntervalMs: number;
    heartbeatUrl: string;
    httpTimeoutMs: number;
    leaseTtlMs: number;
    ownerId: string;
    releaseUrl: string;
    role: QaCredentialRole;
};
export type QaCredentialLeaseHeartbeat = {
    getFailure(): Error | null;
    stop(): Promise<void>;
    throwIfFailed(): void;
};
export type QaCredentialRole = "ci" | "maintainer";
export type QaCredentialLeaseSource = "convex" | "env";
export type QaCredentialLease<TPayload> = {
    credentialId?: string;
    heartbeat(): Promise<void>;
    heartbeatIntervalMs: number;
    kind: string;
    leaseToken?: string;
    leaseTtlMs: number;
    ownerId?: string;
    payload: TPayload;
    release(): Promise<void>;
    role?: QaCredentialRole;
    source: QaCredentialLeaseSource;
};
export type AcquireQaCredentialLeaseOptions<TPayload> = {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    kind: string;
    ownerId?: string;
    parsePayload: (payload: unknown) => TPayload;
    randomImpl?: () => number;
    resolveEnvPayload: () => TPayload;
    role?: string;
    sleepImpl?: (ms: number) => Promise<unknown>;
    source?: string;
    timeImpl?: () => number;
};
declare function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number;
declare function normalizeQaCredentialSource(value: string | undefined): QaCredentialLeaseSource;
declare function normalizeQaCredentialRole(value: string | undefined): QaCredentialRole;
declare function resolveConvexCredentialBrokerConfig(params: {
    env: NodeJS.ProcessEnv;
    ownerId?: string;
    role: QaCredentialRole;
}): ConvexCredentialBrokerConfig;
declare function computeAcquireBackoffMs(params: {
    attempt: number;
    randomImpl: () => number;
    retryAfterMs?: number;
}): number;
export declare function acquireQaCredentialLease<TPayload>(opts: AcquireQaCredentialLeaseOptions<TPayload>): Promise<QaCredentialLease<TPayload>>;
export declare function startQaCredentialLeaseHeartbeat(lease: Pick<QaCredentialLease<unknown>, "heartbeat" | "heartbeatIntervalMs" | "kind" | "source">, opts?: {
    intervalMs?: number;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
}): QaCredentialLeaseHeartbeat;
export declare const __testing: {
    DEFAULT_ACQUIRE_TIMEOUT_MS: number;
    DEFAULT_ENDPOINT_PREFIX: string;
    DEFAULT_HEARTBEAT_INTERVAL_MS: number;
    DEFAULT_LEASE_TTL_MS: number;
    computeAcquireBackoffMs: typeof computeAcquireBackoffMs;
    normalizeQaCredentialRole: typeof normalizeQaCredentialRole;
    normalizeQaCredentialSource: typeof normalizeQaCredentialSource;
    parsePositiveIntegerEnv: typeof parsePositiveIntegerEnv;
    resolveConvexCredentialBrokerConfig: typeof resolveConvexCredentialBrokerConfig;
};
export {};
