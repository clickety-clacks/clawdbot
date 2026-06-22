import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelSelection } from "./model-selection-resolver.js";

describe("resolveSessionModelSelection", () => {
  it("resolves override before runtime, snapshot, and default state", () => {
    const entry: SessionEntry = {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      modelProvider: "openai",
      model: "gpt-5.5",
    };

    const selection = resolveSessionModelSelection({
      cfg: {},
      entry,
      sessionKey: "sess-selection",
      snapshot: { provider: "zai", model: "glm-4.6" },
    });

    expect(selection).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runtime: "auto",
      source: "override",
    });
  });

  it("keeps a persisted harness id only when it matches the selected runtime", () => {
    const entry: SessionEntry = {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      agentHarnessId: "codex",
    };

    const selection = resolveSessionModelSelection({
      cfg: {},
      entry,
      sessionKey: "sess-selection",
    });

    expect(selection.harnessId).toBeUndefined();
  });

  it("returns inherited default selection when the session has no model state", () => {
    const selection = resolveSessionModelSelection({
      cfg: { model: "openai/gpt-5.5" },
      sessionKey: "sess-default",
    });

    expect(selection).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      runtime: "codex",
      source: "default",
    });
  });
});
