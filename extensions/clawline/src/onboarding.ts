import type { ChannelOnboardingAdapter, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { formatDocsLink } from "clawdbot/plugin-sdk";

const DOCS_PATH = "/providers/clawline";
const DEFAULT_PORT = 18800;
const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_ORIGINS = ["null"];

function sanitizeBindAddress(input: string | undefined): string {
  const trimmed = input?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BIND;
}

function sanitizeOrigins(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ensureClawlineBlock(cfg: ClawdbotConfig): NonNullable<ClawdbotConfig["clawline"]> {
  return cfg.clawline ?? {};
}

export const clawlineOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "clawline",
  async getStatus({ cfg }) {
    const enabled = cfg.clawline?.enabled === true;
    const port = cfg.clawline?.port ?? DEFAULT_PORT;
    const bindAddress = cfg.clawline?.network?.bindAddress ?? DEFAULT_BIND;
    const statusLines = [
      enabled
        ? `Clawline: enabled (${bindAddress}:${port})`
        : "Clawline: disabled (opt-in, local channel)",
      `Docs: ${formatDocsLink(DOCS_PATH, "providers/clawline")}`,
    ];
    return {
      channel: "clawline",
      configured: enabled,
      selectionHint: enabled ? "enabled" : "disabled",
      quickstartScore: enabled ? 5 : 0,
      statusLines,
    };
  },
  async configure({ cfg, prompter }) {
    const current = ensureClawlineBlock(cfg);
    const currentlyEnabled = current.enabled === true;
    const enable = await prompter.confirm({
      message: "Enable the Clawline local channel?",
      initialValue: currentlyEnabled,
    });

    if (!enable) {
      return {
        cfg: {
          ...cfg,
          clawline: {
            ...current,
            enabled: false,
          },
        },
      };
    }

    const bindAddress = sanitizeBindAddress(
      await prompter.text({
        message: "Bind address (use 0.0.0.0 for LAN access)",
        initialValue: current.network?.bindAddress ?? DEFAULT_BIND,
      }),
    );

    const portInput = await prompter.text({
      message: "Port",
      initialValue: String(current.port ?? DEFAULT_PORT),
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Port is required";
        const num = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(num) || num < 1 || num > 65535) {
          return "Enter a port between 1-65535";
        }
        return undefined;
      },
    });
    const port = Number.parseInt(portInput.trim(), 10);

    const allowPublic = await prompter.confirm({
      message: "Allow LAN/public clients (sets allowInsecurePublic)?",
      initialValue: current.network?.allowInsecurePublic ?? false,
    });

    let allowedOrigins = current.network?.allowedOrigins ?? DEFAULT_ORIGINS;
    if (allowPublic) {
      const originsInput = await prompter.text({
        message: "Allowed HTTPS origins (comma-separated)",
        initialValue: allowedOrigins.join(", "),
        placeholder: "https://example.com, https://vpn.example.net",
      });
      const parsed = sanitizeOrigins(originsInput);
      if (parsed.length > 0) {
        allowedOrigins = parsed;
      }
    } else {
      allowedOrigins = DEFAULT_ORIGINS;
    }

    const next: ClawdbotConfig = {
      ...cfg,
      clawline: {
        ...current,
        enabled: true,
        port,
        network: {
          ...current.network,
          bindAddress,
          allowInsecurePublic: allowPublic,
          allowedOrigins,
        },
      },
    };

    return { cfg: next };
  },
  disable: (cfg) => ({
    ...cfg,
    clawline: {
      ...(cfg.clawline ?? {}),
      enabled: false,
    },
  }),
};
