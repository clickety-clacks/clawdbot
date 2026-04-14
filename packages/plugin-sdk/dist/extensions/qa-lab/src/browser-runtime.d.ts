type QaBrowserGateway = {
    call: (method: string, params: Record<string, unknown>, opts?: {
        timeoutMs?: number;
    }) => Promise<unknown>;
};
type QaBrowserEnv = {
    gateway: QaBrowserGateway;
};
type QaBrowserRequestParams = {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    timeoutMs?: number;
};
type QaBrowserOpenTabParams = {
    url: string;
    profile?: string;
    timeoutMs?: number;
};
type QaBrowserSnapshotParams = {
    profile?: string;
    targetId?: string;
    format?: "ai" | "aria";
    limit?: number;
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    selector?: string;
    frame?: string;
    labels?: boolean;
    mode?: "efficient";
    maxChars?: number;
    timeoutMs?: number;
};
type QaBrowserActRequest = {
    kind: string;
    targetId?: string;
    ref?: string;
    doubleClick?: boolean;
    button?: string;
    modifiers?: string[];
    text?: string;
    submit?: boolean;
    slowly?: boolean;
    key?: string;
    delayMs?: number;
    startRef?: string;
    endRef?: string;
    values?: string[];
    fields?: Array<Record<string, unknown>>;
    width?: number;
    height?: number;
    timeMs?: number;
    selector?: string;
    url?: string;
    loadState?: string;
    textGone?: string;
    timeoutMs?: number;
    fn?: string;
};
type QaBrowserActParams = {
    profile?: string;
    request: QaBrowserActRequest;
    timeoutMs?: number;
};
type QaBrowserStatus = {
    enabled?: boolean;
    running?: boolean;
    cdpReady?: boolean;
};
type QaBrowserReadyParams = {
    profile?: string;
    timeoutMs?: number;
    intervalMs?: number;
};
export declare function callQaBrowserRequest<T = unknown>(env: QaBrowserEnv, params: QaBrowserRequestParams): Promise<T>;
export declare function qaBrowserOpenTab<T = unknown>(env: QaBrowserEnv, params: QaBrowserOpenTabParams): Promise<T>;
export declare function qaBrowserSnapshot<T = unknown>(env: QaBrowserEnv, params?: QaBrowserSnapshotParams): Promise<T>;
export declare function qaBrowserAct<T = unknown>(env: QaBrowserEnv, params: QaBrowserActParams): Promise<T>;
export declare function waitForQaBrowserReady<T extends QaBrowserStatus = QaBrowserStatus>(env: QaBrowserEnv, params?: QaBrowserReadyParams): Promise<T>;
export {};
