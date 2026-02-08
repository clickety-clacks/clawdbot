import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  ClawlineDeliveryTarget,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import { clawlineMessageActions } from "./actions.js";
import { ClawlineConfigSchema } from "./config-schema.js";
import { clawlineOnboardingAdapter } from "./onboarding.js";
import { clawlineOutbound } from "./outbound.js";

type ResolvedClawlineAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

function normalizeClawlineTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("user:")) {
    return `user:${trimmed.slice("user:".length).trim()}`;
  }
  if (lower.startsWith("device:")) {
    return `device:${trimmed.slice("device:".length).trim()}`;
  }
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

export const clawlinePlugin: ChannelPlugin<ResolvedClawlineAccount> = {
  id: "clawline",
  meta: {
    ...meta,
    showConfigured: false,
  },
  onboarding: clawlineOnboardingAdapter,
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  reload: { configPrefixes: ["channels.clawline"] },
  configSchema: buildChannelConfigSchema(ClawlineConfigSchema),
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
      if (!context.OriginatingTo) {
        return undefined;
      }
      let target: ClawlineDeliveryTarget;
      try {
        target = ClawlineDeliveryTarget.fromString(context.OriginatingTo);
      } catch {
        return undefined;
      }
      return {
        currentChannelId: target.toString(),
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
        ...cfg.channels,
        clawline: {
          ...cfg.channels?.clawline,
          enabled,
        },
      },
    }),
  },
  outbound: clawlineOutbound,
};
