import type { LegacyConfigRule } from "../../config/legacy.shared.js";
type BundledChannelDoctorContractApi = {
    legacyConfigRules?: readonly LegacyConfigRule[];
};
export declare function loadBundledChannelDoctorContractApi(channelId: string): BundledChannelDoctorContractApi | undefined;
export {};
