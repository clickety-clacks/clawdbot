import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  createChannelPluginBase,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { clawlineMessageActions } from "./actions.js";
import { ClawlineConfigSchema } from "./config-schema.js";
import { clawlineSetupAdapter, clawlineSetupWizard } from "./onboarding.js";
import { clawlineOutbound } from "./outbound.js";
import { ClawlineDeliveryTarget } from "./runtime/routing.js";

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

const clawlinePluginBase = createChannelPluginBase({
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
    deleteAccount: undefined,
    isConfigured: (account) => account.configured,
    describeAccount: (account) =>
      describeAccountSnapshot({
        account,
        configured: account.configured,
      }),
  },
  setup: clawlineSetupAdapter,
}) as ReturnType<typeof createChannelPluginBase<ResolvedClawlineAccount>> &
  Pick<
    ChannelPlugin<ResolvedClawlineAccount>,
    "setupWizard" | "capabilities" | "reload" | "configSchema" | "config"
  >;

export const clawlinePlugin = {
  ...clawlinePluginBase,
  // Clawline runs as a plugin service, not a channel gateway startAccount loop.
  // Mark runtime as running so gateway health-monitor does not treat it as stopped.
  status: {
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? true,
      connected: runtime?.connected ?? true,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: true,
      connected: true,
    },
  },
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
      const currentTarget = context.NativeChannelId?.trim() || context.To?.trim();
      if (!currentTarget) {
        return undefined;
      }
      let target: ClawlineDeliveryTarget;
      try {
        target = ClawlineDeliveryTarget.fromString(currentTarget);
      } catch {
        return undefined;
      }
      return {
        currentChannelId: target.toString(),
        hasRepliedRef,
      };
    },
  },
  outbound: clawlineOutbound,
} satisfies ChannelPlugin<ResolvedClawlineAccount>;
