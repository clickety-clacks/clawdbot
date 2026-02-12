import { describe, expect, it } from "vitest";
import { ClawlineConfigSchema } from "./config-schema.js";

describe("ClawlineConfigSchema", () => {
  it("accepts stream Phase A limits", () => {
    const parsed = ClawlineConfigSchema.parse({
      streams: {
        maxStreamsPerUser: 32,
        maxDisplayNameBytes: 120,
      },
    });

    expect(parsed.streams?.maxStreamsPerUser).toBe(32);
    expect(parsed.streams?.maxDisplayNameBytes).toBe(120);
  });

  it("rejects non-phaseA built-in rename/delete flags", () => {
    expect(() =>
      ClawlineConfigSchema.parse({
        streams: {
          allowBuiltInRename: true,
        },
      }),
    ).toThrow();
  });
});
