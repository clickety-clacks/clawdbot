import type { ChannelPlugin, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, getChatChannelMeta } from "clawdbot/plugin-sdk";

import { clawlineOutbound } from "./outbound.js";

type ResolvedClawlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = getChatChannelMeta("clawline");

function resolveClawlineAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedClawlineAccount {
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const enabled = params.cfg.clawline?.enabled !== false;
  return {
    accountId: resolvedAccountId,
    enabled,
    configured: true,
  };
}

export const clawlinePlugin: ChannelPlugin<ResolvedClawlineAccount> = {
  id: "clawline",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["clawline"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveClawlineAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      clawline: {
        ...(cfg.clawline ?? {}),
        enabled,
      },
    }),
  },
  outbound: clawlineOutbound,
};
