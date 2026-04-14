export type QaCronRunLogEntry = {
    ts?: number;
    status?: "ok" | "error" | "skipped";
    summary?: string;
    error?: string;
    deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
};
export declare function waitForCronRunCompletion(params: {
    callGateway: (method: string, rpcParams?: unknown, opts?: {
        timeoutMs?: number;
    }) => Promise<unknown>;
    jobId: string;
    afterTs: number;
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<QaCronRunLogEntry>;
