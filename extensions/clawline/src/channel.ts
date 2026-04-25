import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { type ChannelPlugin } from "openclaw/plugin-sdk/core";
import { clawlineMessageActions } from "./actions.js";
import { clawlineSetupPlugin, type ResolvedClawlineAccount } from "./channel.setup.js";
import { clawlineOutbound } from "./outbound.js";
import { ClawlineDeliveryTarget } from "./runtime/routing.js";

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

export const clawlinePlugin = {
  ...clawlineSetupPlugin,
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
