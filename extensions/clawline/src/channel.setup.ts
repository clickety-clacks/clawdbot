import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  createChannelPluginBase,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { stopGatewayServiceBeforeChannelConfigDelete } from "openclaw/plugin-sdk/gateway-lifecycle";
import { ClawlineConfigSchema } from "./config-schema.js";
import { clawlineSetupAdapter, clawlineSetupWizard } from "./onboarding.js";

export type ResolvedClawlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "clawline",
  label: "Clawline",
  selectionLabel: "Clawline (local devices)",
  docsPath: "/channels/clawline",
  docsLabel: "clawline",
  blurb: "first-party local gateway; enable via config/onboarding.",
  aliases: ["clawline-dm"],
  order: 900,
};

function resolveClawlineAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedClawlineAccount {
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const enabled = params.cfg.channels?.clawline?.enabled === true;
  return {
    accountId: resolvedAccountId,
    enabled,
    configured: enabled,
  };
}

const clawlineConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedClawlineAccount>({
  sectionKey: "clawline",
  resolveAccount: (cfg) => resolveClawlineAccount({ cfg }),
  resolveAllowFrom: () => undefined,
  formatAllowFrom: () => [],
});

export const clawlineSetupPlugin = createChannelPluginBase({
  id: "clawline",
  meta: {
    ...meta,
    showConfigured: false,
    aliases: [...meta.aliases],
  },
  setupWizard: clawlineSetupWizard,
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  reload: { configPrefixes: ["channels.clawline"] },
  configSchema: buildChannelConfigSchema(ClawlineConfigSchema),
  config: {
    ...clawlineConfigAdapter,
    deleteAccount: clawlineConfigAdapter.deleteAccount,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
      }),
  },
  setup: clawlineSetupAdapter,
  lifecycle: {
    beforeAccountRemoved: async () => {
      const stopped = await stopGatewayServiceBeforeChannelConfigDelete();
      if (!stopped) {
        throw new Error("Gateway service did not stop before Clawline config deletion.");
      }
    },
  },
}) as ReturnType<typeof createChannelPluginBase<ResolvedClawlineAccount>> &
  Pick<
    ChannelPlugin<ResolvedClawlineAccount>,
    "setupWizard" | "capabilities" | "reload" | "configSchema" | "config"
  >;
