import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export declare function collectFeishuSecurityAuditFindings(params: {
    cfg: OpenClawConfig;
}): {
    checkId: string;
    severity: "warn";
    title: string;
    detail: string;
    remediation: string;
}[];
