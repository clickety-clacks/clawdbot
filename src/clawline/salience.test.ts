import { describe, expect, it } from "vitest";
import { extractAssistantSalience } from "./salience.js";

describe("extractAssistantSalience", () => {
  it("extracts a compact verb-object action phrase as the primary candidate", () => {
    const result = extractAssistantSalience(
      "We should run database migrations before deploying tonight. The rest can wait.",
      123,
    );
    expect(result).toBeDefined();
    expect(result?.source).toBe("heuristic");
    expect(result?.generatedAt).toBe(123);
    expect(result?.candidates[0]).toMatchObject({
      kind: "action",
      tier: "primary",
    });
    expect(result?.candidates[0]?.text.toLowerCase()).toContain("run database migrations");
  });

  it("highlights as little as possible by default", () => {
    const result = extractAssistantSalience(
      [
        "Decision: keep the current API surface for this release.",
        "Next step: run migration checks in staging.",
        "Also monitor error rates for one hour after deploy.",
      ].join(" "),
      0,
    );
    expect(result).toBeDefined();
    expect((result?.candidates.length ?? 0) <= 2).toBe(true);
  });

  it("prefers action/intent phrases over bare topic nouns", () => {
    const result = extractAssistantSalience(
      "Database migrations are risky. Run database migrations before deploy.",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.candidates[0]?.text.toLowerCase()).toContain("run database migrations");
  });

  it("can mark concise answer-like responses with actionable intent", () => {
    const result = extractAssistantSalience(
      "Yes, restart the gateway and verify channel status afterwards.",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.candidates[0]).toBeDefined();
    expect(result?.candidates[0]?.text.toLowerCase()).toContain("restart the gateway");
  });

  it("returns undefined for text without actionable or core salience", () => {
    const result = extractAssistantSalience("Database migrations", 0);
    expect(result).toBeUndefined();
  });
});
