import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { QaBusState } from "./bus-state.js";
export declare function writeJson(res: ServerResponse, statusCode: number, body: unknown): void;
export declare function writeError(res: ServerResponse, statusCode: number, error: unknown): void;
export declare function closeQaHttpServer(server: Server): Promise<void>;
export declare function handleQaBusRequest(params: {
    req: IncomingMessage;
    res: ServerResponse;
    state: QaBusState;
}): Promise<boolean>;
export declare function createQaBusServer(state: QaBusState): Server;
export declare function startQaBusServer(params: {
    state: QaBusState;
    port?: number;
}): Promise<{
    server: Server<typeof IncomingMessage, typeof ServerResponse>;
    port: number;
    baseUrl: string;
    stop(): Promise<void>;
}>;
