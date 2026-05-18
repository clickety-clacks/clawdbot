import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGatewayTlsRuntime } from "openclaw/plugin-sdk/gateway-runtime";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  applySessionsPatchToStore,
  enqueueAnnounce,
  resolveAllAgentSessionStoreTargetsSync,
} from "../runtime-api.js";

describe("Clawline SDK runtime seams", () => {
  it("exposes enqueueAnnounce through Clawline's SDK-only runtime barrel", () => {
    expect(typeof enqueueAnnounce).toBe("function");
  });

  it("uses the SDK session patch export without importing gateway internals", async () => {
    const sessionKey = "agent:main:clawline:flynn:main";
    const store = {};
    const result = await applySessionsPatchToStore({
      cfg: {} as OpenClawConfig,
      store,
      storeKey: sessionKey,
      patch: {
        key: sessionKey,
        fastMode: true,
        thinkingLevel: "high",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      entry: {
        fastMode: true,
        thinkingLevel: "high",
      },
    });
  });

  it("discovers cross-agent session stores through the SDK export Clawline uses", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-sdk-session-targets-"));
    try {
      const storePath = path.join(
        root,
        ".openclaw",
        "agents",
        "heimdal",
        "sessions",
        "sessions.json",
      );
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, "{}\n");
      const realStorePath = await fs.realpath(storePath);

      const targets = resolveAllAgentSessionStoreTargetsSync({} as OpenClawConfig, {
        env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") },
      });

      expect(targets).toContainEqual({ agentId: "heimdal", storePath: realStorePath });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the gateway TLS runtime through the public SDK subpath", async () => {
    expect(typeof loadGatewayTlsRuntime).toBe("function");
    await expect(loadGatewayTlsRuntime(undefined)).resolves.toMatchObject({
      enabled: false,
    });
  });
});
