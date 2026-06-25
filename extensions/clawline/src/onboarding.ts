import { randomBytes } from "node:crypto";
import { restartGatewayServiceAfterChannelConfigWrite } from "openclaw/plugin-sdk/gateway-lifecycle";
import type {
  ChannelSetupAdapter,
  ChannelSetupWizard,
  OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import {
  createStandardChannelSetupStatus,
  formatDocsLink,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";

const DOCS_PATH = "/channels/clawline";
const DEFAULT_PORT = 18800;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_ORIGINS = ["null"];
const channel = "clawline" as const;
const CLU_SECRET_BYTES = 32;

function sanitizeBindAddress(input: string | undefined): string {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BIND;
}

function ensureClawlineBlock(
  cfg: OpenClawConfig,
): NonNullable<NonNullable<OpenClawConfig["channels"]>["clawline"]> {
  return cfg.channels?.clawline ?? {};
}

function generateCluSecret(): string {
  return randomBytes(CLU_SECRET_BYTES).toString("base64url");
}

export const clawlineSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "Clawline",
    configuredLabel: "enabled",
    unconfiguredLabel: "disabled",
    configuredHint: "local channel enabled",
    unconfiguredHint: "opt-in local channel",
    configuredScore: 5,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => cfg.channels?.clawline?.enabled === true,
    resolveExtraStatusLines: ({ cfg, configured }) => {
      const port = cfg.channels?.clawline?.port ?? DEFAULT_PORT;
      const bindAddress = cfg.channels?.clawline?.network?.bindAddress ?? DEFAULT_BIND;
      return [
        configured
          ? `Listening on ${bindAddress}:${port}`
          : `Default listen address ${DEFAULT_BIND}:${DEFAULT_PORT}`,
        `Docs: ${formatDocsLink(DOCS_PATH, "channels/clawline")}`,
      ];
    },
  }),
  introNote: {
    title: "Clawline setup",
    lines: [
      "Clawline is a local-device channel managed by the gateway host.",
      "Enable it here, then set optional network/media/server fields in config if needed.",
      "Re-adding Clawline regenerates the CLU secret and restarts the gateway so the new secret is live.",
      `Docs: ${formatDocsLink(DOCS_PATH, "channels/clawline")}`,
    ],
  },
  credentials: [],
  textInputs: [],
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export const clawlineSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig: ({ cfg }) => {
    const current = ensureClawlineBlock(cfg);
    const port = current.port ?? DEFAULT_PORT;
    const bindAddress = sanitizeBindAddress(current.network?.bindAddress);
    const allowedOrigins =
      current.network?.allowedOrigins && current.network.allowedOrigins.length > 0
        ? current.network.allowedOrigins
        : DEFAULT_ORIGINS;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        clawline: {
          ...current,
          enabled: true,
          port,
          network: {
            ...current.network,
            bindAddress,
            allowedOrigins,
          },
          server: {
            ...current.server,
            cluSecret: generateCluSecret(),
          },
        },
      },
    };
  },
  requireSuccessfulPostWrite: true,
  afterAccountConfigWritten: async () => {
    const restarted = await restartGatewayServiceAfterChannelConfigWrite();
    if (!restarted) {
      throw new Error("Gateway restart did not complete after Clawline config write.");
    }
  },
};
