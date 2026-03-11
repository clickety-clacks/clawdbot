import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./agent.js";

describe("resolveFallbackRetryPrompt", () => {
  it("keeps the generic continuation prompt for non-alert fallback retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "Regular user message",
        isFallbackRetry: true,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });

  it("preserves system alert bodies across fallback retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "System Alert: Check on Flynn",
        isFallbackRetry: true,
      }),
    ).toBe(
      "System Alert: Check on Flynn\n\nThe previous model attempt failed or timed out. Continue handling this exact alert and do not answer with NO_REPLY unless the alert explicitly requires silence.",
    );
  });
});
