type CompatMutationResult = {
    entry: Record<string, unknown>;
    changed: boolean;
};
export declare function asObjectRecord(value: unknown): Record<string, unknown> | null;
export declare function hasLegacyAccountStreamingAliases(value: unknown, match: (entry: unknown) => boolean): boolean;
export declare function normalizeLegacyDmAliases(params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
    promoteAllowFrom?: boolean;
}): CompatMutationResult;
export declare function normalizeLegacyStreamingAliases(params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
    resolvedMode: string;
    includePreviewChunk?: boolean;
    resolvedNativeTransport?: unknown;
    offModeLegacyNotice?: (pathPrefix: string) => string;
}): CompatMutationResult;
export declare function hasLegacyStreamingAliases(value: unknown, options?: {
    includePreviewChunk?: boolean;
    includeNativeTransport?: boolean;
}): boolean;
export {};
