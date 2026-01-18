import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveClawlineConfig } from "./config.js";

describe("resolveClawlineConfig", () => {
  const home = os.homedir();

  it("applies defaults when config is missing", () => {
    const cfg = resolveClawlineConfig({} as ClawdbotConfig);
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(18800);
    expect(cfg.statePath).toBe(path.join(home, ".clawdbot", "clawline"));
    expect(cfg.media.storagePath).toBe(
      path.join(home, ".clawdbot", "clawline-media"),
    );
    expect(cfg.alertInstructionsPath).toBe(
      path.join(home, ".clawdbot", "clawline", "alert-instructions.md"),
    );
    expect(cfg.network.bindAddress).toBe("127.0.0.1");
    expect(cfg.network.allowInsecurePublic).toBe(false);
    expect(cfg.alertTarget).toEqual({ channel: "clawline", to: "flynn" });
  });

  it("merges overrides from config", () => {
    const cfg = resolveClawlineConfig({
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
        alertInstructionsPath: "/tmp/clawline/alerts.md",
      },
    } as ClawdbotConfig);

    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(1234);
    expect(cfg.statePath).toBe("/tmp/clawline");
    expect(cfg.media.storagePath).toBe("/tmp/media");
    expect(cfg.alertInstructionsPath).toBe("/tmp/clawline/alerts.md");
    expect(cfg.network.bindAddress).toBe("0.0.0.0");
    expect(cfg.network.allowInsecurePublic).toBe(true);
    expect(cfg.network.allowedOrigins).toEqual(["https://example.com"]);
  });

  it("expands tildes in configurable paths", () => {
    const cfg = resolveClawlineConfig({
      clawline: {
        statePath: "~/custom/clawline",
        media: {
          storagePath: "~/custom/media",
        },
        alertInstructionsPath: "~/custom/instructions.md",
      },
    } as ClawdbotConfig);

    expect(cfg.statePath).toBe(path.join(home, "custom", "clawline"));
    expect(cfg.media.storagePath).toBe(
      path.join(home, "custom", "media"),
    );
    expect(cfg.alertInstructionsPath).toBe(
      path.join(home, "custom", "instructions.md"),
    );
  });

  it("resolves relative media paths to absolute", () => {
    const cfg = resolveClawlineConfig({
      clawline: {
        media: {
          storagePath: "relative/media",
        },
        alertInstructionsPath: "relative/instructions.md",
      },
    } as ClawdbotConfig);

    expect(cfg.media.storagePath).toBe(
      path.resolve("relative/media"),
    );
    expect(cfg.alertInstructionsPath).toBe(
      path.resolve("relative/instructions.md"),
    );
  });

  it("merges alert target overrides", () => {
    const cfg = resolveClawlineConfig({
      clawline: {
        alertTarget: {
          to: "river",
        },
      },
    } as ClawdbotConfig);

    expect(cfg.alertTarget.channel).toBe("clawline");
    expect(cfg.alertTarget.to).toBe("river");
  });
});
