import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

describe("codex plugin", () => {
  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("does not register a model provider or agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerProvider = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerCommand,
        registerProvider,
      }),
    );

    expect(registerProvider).not.toHaveBeenCalled();
    expect(registerAgentHarness).not.toHaveBeenCalled();
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "codex",
      description: "Inspect and control the Codex app-server harness",
    });
  });
});
