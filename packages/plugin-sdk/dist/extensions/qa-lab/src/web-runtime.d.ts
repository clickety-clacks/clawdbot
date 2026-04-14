type QaWebOpenPageParams = {
    url: string;
    headless?: boolean;
    channel?: "chrome";
    timeoutMs?: number;
    viewport?: {
        width: number;
        height: number;
    };
};
type QaWebWaitParams = {
    pageId: string;
    selector?: string;
    text?: string;
    timeoutMs?: number;
};
type QaWebTypeParams = {
    pageId: string;
    selector: string;
    text: string;
    submit?: boolean;
    timeoutMs?: number;
};
type QaWebSnapshotParams = {
    pageId: string;
    timeoutMs?: number;
    maxChars?: number;
};
type QaWebEvaluateParams = {
    pageId: string;
    expression: string;
    timeoutMs?: number;
};
export declare function qaWebOpenPage(params: QaWebOpenPageParams): Promise<{
    pageId: `${string}-${string}-${string}-${string}-${string}`;
    url: string;
    title: string;
}>;
export declare function qaWebWait(params: QaWebWaitParams): Promise<{
    ok: boolean;
}>;
export declare function qaWebType(params: QaWebTypeParams): Promise<{
    ok: boolean;
}>;
export declare function qaWebSnapshot(params: QaWebSnapshotParams): Promise<{
    url: string;
    title: string;
    text: string;
}>;
export declare function qaWebEvaluate<T = unknown>(params: QaWebEvaluateParams): Promise<T>;
export declare function closeQaWebSessions(pageIds?: Iterable<string>): Promise<void>;
export declare function closeAllQaWebSessions(): Promise<void>;
export {};
