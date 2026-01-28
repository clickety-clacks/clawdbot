import type { ChannelPlugin, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, getChatChannelMeta } from "clawdbot/plugin-sdk";

import { clawlineMessageActions } from "./actions.js";
import { clawlineOnboardingAdapter } from "./onboarding.js";
import { clawlineOutbound } from "./outbound.js";

type ResolvedClawlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

function parseClawlineUserId(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex < 0) return stripClawlineChannelSuffix(trimmed);
  const value = trimmed.slice(colonIndex + 1).trim();
  return stripClawlineChannelSuffix(value || undefined);
}

function stripClawlineChannelSuffix(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("-admin")) return trimmed.slice(0, -"-admin".length);
  if (lower.endsWith("-personal")) return trimmed.slice(0, -"-personal".length);
  return trimmed;
}

function normalizeClawlineTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("user:")) return `user:${trimmed.slice("user:".length).trim()}`;
  if (lower.startsWith("device:")) return `device:${trimmed.slice("device:".length).trim()}`;
  return trimmed;
}

const meta = {
  id: "clawline",
  label: "Clawline",
  selectionLabel: "Clawline (local devices)",
  docsPath: "/providers/clawline",
  docsLabel: "clawline",
  blurb: "first-party local gateway; enable via config/onboarding.",
  aliases: ["clawline-dm"],
  order: 10,
} as const;

function resolveClawlineAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedClawlineAccount {
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const enabled = params.cfg.channels?.clawline?.enabled === true;
  return {
    accountId: resolvedAccountId,
    enabled,
    configured: true,
  };
}

export const clawlinePlugin: ChannelPlugin<ResolvedClawlineAccount> = {
  id: "clawline",
  meta: {
    ...meta,
    showConfigured: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  reload: { configPrefixes: ["channels.clawline"] },
  actions: clawlineMessageActions,
  // Accept any target as valid - Clawline actions do their own filtering
  // via userId/channelType params, not standard target resolution.
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      hint: "Clawline targets are user IDs or device IDs",
    },
    normalizeTarget: normalizeClawlineTarget,
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => {
      const userId =
        parseClawlineUserId(context.OriginatingTo) ?? parseClawlineUserId(context.From);
      if (!userId) return undefined;
      return {
        currentChannelId: `user:${userId}`,
        hasRepliedRef,
      };
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveClawlineAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account, cfg) =>
      Boolean(cfg.channels?.clawline?.enabled === true && account.enabled === true),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...(cfg.channels ?? {}),
        clawline: {
          ...(cfg.channels?.clawline ?? {}),
          enabled,
        },
      },
    }),
  },
  outbound: clawlineOutbound,
};
