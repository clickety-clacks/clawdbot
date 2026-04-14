import type { ChannelDoctorAdapter, ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
export declare const legacyConfigRules: import("../../../src/config/legacy.shared.ts").LegacyConfigRule[];
export declare function normalizeCompatibilityConfig(params: {
    cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation;
export declare const collectZalouserMutableAllowlistWarnings: ({ cfg }: {
    cfg: OpenClawConfig;
}) => string[];
export declare const zalouserDoctor: ChannelDoctorAdapter;
