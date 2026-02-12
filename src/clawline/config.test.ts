import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveClawlineConfig } from "./config.js";

describe("resolveClawlineConfig", () => {
  const home = os.homedir();

  it("applies defaults when config is missing", () => {
    const cfg = resolveClawlineConfig({} as OpenClawConfig);
    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(18800);
    expect(cfg.statePath).toBe(path.join(home, ".openclaw", "clawline"));
    expect(cfg.media.storagePath).toBe(path.join(home, ".openclaw", "clawline-media"));
    expect(cfg.alertInstructionsPath).toBe(
      path.join(home, ".openclaw", "clawline", "alert-instructions.md"),
    );
    expect(cfg.terminal.tmux.mode).toBe("local");
    expect(cfg.terminal.tmux.ssh.target).toBe("");
    expect(cfg.network.bindAddress).toBe("127.0.0.1");
    expect(cfg.network.allowInsecurePublic).toBe(false);
    expect(cfg.streams.maxStreamsPerUser).toBe(32);
    expect(cfg.streams.maxDisplayNameBytes).toBe(120);
    expect(Object.hasOwn(cfg.streams, "allowBuiltInRename")).toBe(false);
    expect(Object.hasOwn(cfg.streams, "allowBuiltInDelete")).toBe(false);
  });

  it("merges overrides from config", () => {
    const cfg = resolveClawlineConfig({
      channels: {
        clawline: {
          enabled: false,
          port: 1234,
          statePath: "/tmp/clawline",
          network: {
            bindAddress: "0.0.0.0",
            allowInsecurePublic: true,
            allowedOrigins: ["https://example.com"],
          },
          media: {
            storagePath: "/tmp/media",
          },
          streams: {
            maxStreamsPerUser: 64,
            maxDisplayNameBytes: 80,
          },
          alertInstructionsPath: "/tmp/clawline/alerts.md",
        },
      },
    } as OpenClawConfig);

    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(1234);
    expect(cfg.statePath).toBe("/tmp/clawline");
    expect(cfg.media.storagePath).toBe("/tmp/media");
    expect(cfg.alertInstructionsPath).toBe("/tmp/clawline/alerts.md");
    expect(cfg.network.bindAddress).toBe("0.0.0.0");
    expect(cfg.network.allowInsecurePublic).toBe(true);
    expect(cfg.network.allowedOrigins).toEqual(["https://example.com"]);
    expect(cfg.streams.maxStreamsPerUser).toBe(64);
    expect(cfg.streams.maxDisplayNameBytes).toBe(80);
  });

  it("expands tildes in configurable paths", () => {
    const cfg = resolveClawlineConfig({
      channels: {
        clawline: {
          statePath: "~/custom/clawline",
          media: {
            storagePath: "~/custom/media",
          },
          alertInstructionsPath: "~/custom/instructions.md",
        },
      },
    } as OpenClawConfig);

    expect(cfg.statePath).toBe(path.join(home, "custom", "clawline"));
    expect(cfg.media.storagePath).toBe(path.join(home, "custom", "media"));
    expect(cfg.alertInstructionsPath).toBe(path.join(home, "custom", "instructions.md"));
  });

  it("resolves relative media paths to absolute", () => {
    const cfg = resolveClawlineConfig({
      channels: {
        clawline: {
          media: {
            storagePath: "relative/media",
          },
          alertInstructionsPath: "relative/instructions.md",
        },
      },
    } as OpenClawConfig);

    expect(cfg.media.storagePath).toBe(path.resolve("relative/media"));
    expect(cfg.alertInstructionsPath).toBe(path.resolve("relative/instructions.md"));
  });

  it("allows opt-in enablement", () => {
    const cfg = resolveClawlineConfig({
      channels: { clawline: { enabled: true } },
    } as OpenClawConfig);

    expect(cfg.enabled).toBe(true);
  });
});
