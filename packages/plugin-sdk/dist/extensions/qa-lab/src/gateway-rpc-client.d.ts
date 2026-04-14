type QaGatewayRpcRequestOptions = {
    expectFinal?: boolean;
    timeoutMs?: number;
};
export type QaGatewayRpcClient = {
    request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
    stop(): Promise<void>;
};
export declare function startQaGatewayRpcClient(params: {
    wsUrl: string;
    token: string;
    logs: () => string;
}): Promise<QaGatewayRpcClient>;
export {};
