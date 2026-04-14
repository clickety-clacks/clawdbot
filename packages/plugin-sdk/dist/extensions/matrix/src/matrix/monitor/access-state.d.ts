import type { MatrixAllowListMatch } from "./allowlist.js";
type MatrixCommandAuthorizer = {
    configured: boolean;
    allowed: boolean;
};
export type MatrixMonitorAccessState = {
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
    effectiveRoomUsers: string[];
    groupAllowConfigured: boolean;
    directAllowMatch: MatrixAllowListMatch;
    roomUserMatch: MatrixAllowListMatch | null;
    groupAllowMatch: MatrixAllowListMatch | null;
    commandAuthorizers: [MatrixCommandAuthorizer, MatrixCommandAuthorizer, MatrixCommandAuthorizer];
};
export declare function resolveMatrixMonitorAccessState(params: {
    allowFrom: Array<string | number>;
    storeAllowFrom: Array<string | number>;
    groupAllowFrom: Array<string | number>;
    roomUsers: Array<string | number>;
    senderId: string;
    isRoom: boolean;
}): MatrixMonitorAccessState;
export {};
