import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  resolveSessionDefaultModelSelection,
  resolveSessionModelSelection,
} from "./model-selection-resolver.js";

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

  it("resolves providerless overrides with the inherited default provider", () => {
    const entry: SessionEntry = {
      modelOverride: "deepseek-v3-4bit-mlx",
      modelProvider: "openai",
      model: "gpt-5.5",
    };

    const selection = resolveSessionModelSelection({
      cfg: {},
      entry,
      sessionKey: "sess-selection",
    });

    expect(selection).toMatchObject({
      provider: "openai",
      model: "deepseek-v3-4bit-mlx",
      source: "override",
    });
  });

  it("splits legacy combined provider/model overrides without providerOverride", () => {
    const entry: SessionEntry = {
      modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
    };

    const selection = resolveSessionModelSelection({
      cfg: {},
      entry,
      sessionKey: "sess-selection",
    });

    expect(selection).toMatchObject({
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
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

  it("uses subagent configured model as the inherited default", () => {
    const selection = resolveSessionDefaultModelSelection({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
          list: [
            {
              id: "kimi",
              subagents: { model: "synthetic/hf:moonshotai/Kimi-K2.5" },
            },
          ],
        },
      },
      agentId: "kimi",
      sessionKey: "agent:kimi:subagent:child",
    });

    expect(selection).toEqual({
      provider: "synthetic",
      model: "hf:moonshotai/Kimi-K2.5",
    });
  });

  it("resolves subagent configured model aliases as inherited defaults", () => {
    const selection = resolveSessionDefaultModelSelection({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "synthetic/hf:moonshotai/Kimi-K2.5": { alias: "kimi" },
            },
            subagents: { model: "kimi" },
          },
          list: [{ id: "kimi" }],
        },
      },
      agentId: "kimi",
      sessionKey: "agent:kimi:subagent:child",
    });

    expect(selection).toEqual({
      provider: "synthetic",
      model: "hf:moonshotai/Kimi-K2.5",
    });
  });
});
