import { z } from "zod";
declare const credentialStatusSchema: z.ZodUnion<readonly [z.ZodLiteral<"active">, z.ZodLiteral<"disabled">]>;
declare const listStatusSchema: z.ZodUnion<readonly [z.ZodLiteral<"active">, z.ZodLiteral<"disabled">, z.ZodLiteral<"all">]>;
declare const credentialRecordSchema: z.ZodObject<{
    credentialId: z.ZodString;
    kind: z.ZodString;
    status: z.ZodUnion<readonly [z.ZodLiteral<"active">, z.ZodLiteral<"disabled">]>;
    createdAtMs: z.ZodNumber;
    updatedAtMs: z.ZodNumber;
    lastLeasedAtMs: z.ZodNumber;
    note: z.ZodOptional<z.ZodString>;
    lease: z.ZodOptional<z.ZodObject<{
        ownerId: z.ZodString;
        actorRole: z.ZodUnion<readonly [z.ZodLiteral<"ci">, z.ZodLiteral<"maintainer">]>;
        acquiredAtMs: z.ZodNumber;
        heartbeatAtMs: z.ZodNumber;
        expiresAtMs: z.ZodNumber;
    }, z.core.$strip>>;
    payload: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
declare const listCredentialsResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
    credentials: z.ZodArray<z.ZodObject<{
        credentialId: z.ZodString;
        kind: z.ZodString;
        status: z.ZodUnion<readonly [z.ZodLiteral<"active">, z.ZodLiteral<"disabled">]>;
        createdAtMs: z.ZodNumber;
        updatedAtMs: z.ZodNumber;
        lastLeasedAtMs: z.ZodNumber;
        note: z.ZodOptional<z.ZodString>;
        lease: z.ZodOptional<z.ZodObject<{
            ownerId: z.ZodString;
            actorRole: z.ZodUnion<readonly [z.ZodLiteral<"ci">, z.ZodLiteral<"maintainer">]>;
            acquiredAtMs: z.ZodNumber;
            heartbeatAtMs: z.ZodNumber;
            expiresAtMs: z.ZodNumber;
        }, z.core.$strip>>;
        payload: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>>;
    count: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type QaCredentialAdminListStatus = z.infer<typeof listStatusSchema>;
export type QaCredentialRecord = z.infer<typeof credentialRecordSchema>;
export type QaCredentialListResponse = z.infer<typeof listCredentialsResponseSchema>;
export declare class QaCredentialAdminError extends Error {
    code: string;
    httpStatus?: number;
    constructor(params: {
        code: string;
        message: string;
        httpStatus?: number;
    });
}
type AdminConfig = {
    actorId: string;
    authToken: string;
    addUrl: string;
    endpointPrefix: string;
    httpTimeoutMs: number;
    listUrl: string;
    removeUrl: string;
    siteUrl: string;
};
type AdminBaseOptions = {
    actorId?: string;
    endpointPrefix?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    siteUrl?: string;
};
type AddQaCredentialSetOptions = AdminBaseOptions & {
    kind: string;
    note?: string;
    payload: Record<string, unknown>;
    status?: z.infer<typeof credentialStatusSchema>;
};
type RemoveQaCredentialSetOptions = AdminBaseOptions & {
    credentialId: string;
};
type ListQaCredentialSetsOptions = AdminBaseOptions & {
    includePayload?: boolean;
    kind?: string;
    limit?: number;
    status?: string;
};
declare function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number;
declare function normalizeConvexSiteUrl(raw: string, env: NodeJS.ProcessEnv): string;
declare function normalizeEndpointPrefix(value: string | undefined): string;
declare function resolveAdminConfig(options: AdminBaseOptions): AdminConfig;
declare function normalizeStatus(value: string | undefined): QaCredentialAdminListStatus | undefined;
export declare function addQaCredentialSet(options: AddQaCredentialSetOptions): Promise<{
    status: "ok";
    credential: {
        credentialId: string;
        kind: string;
        status: "disabled" | "active";
        createdAtMs: number;
        updatedAtMs: number;
        lastLeasedAtMs: number;
        note?: string | undefined;
        lease?: {
            ownerId: string;
            actorRole: "ci" | "maintainer";
            acquiredAtMs: number;
            heartbeatAtMs: number;
            expiresAtMs: number;
        } | undefined;
        payload?: unknown;
    };
}>;
export declare function removeQaCredentialSet(options: RemoveQaCredentialSetOptions): Promise<{
    status: "ok";
    changed: boolean;
    credential: {
        credentialId: string;
        kind: string;
        status: "disabled" | "active";
        createdAtMs: number;
        updatedAtMs: number;
        lastLeasedAtMs: number;
        note?: string | undefined;
        lease?: {
            ownerId: string;
            actorRole: "ci" | "maintainer";
            acquiredAtMs: number;
            heartbeatAtMs: number;
            expiresAtMs: number;
        } | undefined;
        payload?: unknown;
    };
}>;
export declare function listQaCredentialSets(options: ListQaCredentialSetsOptions): Promise<{
    status: "ok";
    credentials: {
        credentialId: string;
        kind: string;
        status: "disabled" | "active";
        createdAtMs: number;
        updatedAtMs: number;
        lastLeasedAtMs: number;
        note?: string | undefined;
        lease?: {
            ownerId: string;
            actorRole: "ci" | "maintainer";
            acquiredAtMs: number;
            heartbeatAtMs: number;
            expiresAtMs: number;
        } | undefined;
        payload?: unknown;
    }[];
    count?: number | undefined;
}>;
export declare const __testing: {
    DEFAULT_ENDPOINT_PREFIX: string;
    DEFAULT_HTTP_TIMEOUT_MS: number;
    normalizeConvexSiteUrl: typeof normalizeConvexSiteUrl;
    normalizeEndpointPrefix: typeof normalizeEndpointPrefix;
    normalizeStatus: typeof normalizeStatus;
    parsePositiveIntegerEnv: typeof parsePositiveIntegerEnv;
    resolveAdminConfig: typeof resolveAdminConfig;
};
export {};
