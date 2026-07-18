import { describe, expect, it } from "vitest";
import { ClawlineMetadataContextGenerations } from "./metadata-context-generation.js";

describe("ClawlineMetadataContextGenerations", () => {
  it("keeps one opaque generation per concrete session and exact context", () => {
    let next = 0;
    const generations = new ClawlineMetadataContextGenerations(() => `generation-${++next}`);

    expect(generations.resolve("session-a", "binding-a")).toBe("generation-1");
    expect(generations.resolve("session-a", "binding-a")).toBe("generation-1");
    expect(generations.resolve("session-b", "binding-a")).toBe("generation-2");
  });

  it("advances across binding changes, deletion, and restore ABA", () => {
    let next = 0;
    const generations = new ClawlineMetadataContextGenerations(() => `generation-${++next}`);

    expect(generations.resolve("session-a", "binding-a")).toBe("generation-1");
    expect(generations.resolve("session-a", "binding-unavailable")).toBe("generation-2");
    expect(generations.resolve("session-a", "binding-a")).toBe("generation-3");
    expect(generations.resolve("session-a", "provider-b")).toBe("generation-4");
  });
});
