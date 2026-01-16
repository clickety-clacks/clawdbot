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
    expect(cfg.network.bindAddress).toBe("127.0.0.1");
    expect(cfg.network.allowInsecurePublic).toBe(false);
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
      },
    } as ClawdbotConfig);

    expect(cfg.enabled).toBe(false);
    expect(cfg.port).toBe(1234);
    expect(cfg.statePath).toBe("/tmp/clawline");
    expect(cfg.media.storagePath).toBe("/tmp/media");
    expect(cfg.network.bindAddress).toBe("0.0.0.0");
    expect(cfg.network.allowInsecurePublic).toBe(true);
    expect(cfg.network.allowedOrigins).toEqual(["https://example.com"]);
  });
});
