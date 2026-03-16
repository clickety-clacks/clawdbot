import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./agent.js";

describe("resolveFallbackRetryPrompt", () => {
  it("preserves non-alert fallback retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "Regular user message",
        isFallbackRetry: true,
      }),
    ).toBe("Regular user message");
  });

  it("preserves system alert bodies across fallback retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "System Alert: Check on Flynn",
        isFallbackRetry: true,
      }),
    ).toBe("System Alert: Check on Flynn");
  });

  it("preserves wrapped system alert bodies across fallback retries", () => {
    const body =
      "OpenClaw runtime context (internal):\n- queued event\n\nSystem Alert: Check on Flynn";
    expect(
      resolveFallbackRetryPrompt({
        body,
        isFallbackRetry: true,
      }),
    ).toBe(body);
  });
});
