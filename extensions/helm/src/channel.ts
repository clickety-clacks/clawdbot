import type { ChannelPlugin, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";

import { helmOutbound } from "./outbound.js";

type ResolvedHelmAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const meta = {
  id: "helm",
  label: "Helm",
  selectionLabel: "Helm (visionOS visualizations)",
  docsPath: "/providers/helm",
  docsLabel: "helm",
  blurb: "visionOS spatial visualization channel; renders 3D content on Vision Pro.",
  aliases: ["helm-viz"],
  order: 11,
} as const;

function resolveHelmAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedHelmAccount {
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const enabled = params.cfg.helm?.enabled === true;
  return {
    accountId: resolvedAccountId,
    enabled,
    configured: enabled,
  };
}

export const helmPlugin: ChannelPlugin<ResolvedHelmAccount> = {
  id: "helm",
  meta: {
    ...meta,
    showConfigured: false,
    preferSessionLookupForAnnounceTarget: true,
  },
  capabilities: {
    chatTypes: [],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["helm"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveHelmAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account, cfg) =>
      Boolean(cfg.helm?.enabled === true && account.enabled === true),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      helm: {
        ...cfg.helm,
        enabled,
      },
    }),
  },
  outbound: helmOutbound,
};
