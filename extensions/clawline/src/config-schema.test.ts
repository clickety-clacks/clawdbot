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

  it("accepts server.cluSecret for CLU-secret auth (T140 follow-up)", () => {
    const parsed = ClawlineConfigSchema.parse({
      server: {
        cluSecret: "my-secret-at-least-22chars!!",
      },
    });
    expect(parsed.server?.cluSecret).toBe("my-secret-at-least-22chars!!");
  });

  it("accepts server.cluSecret as null (disables CLU-secret path)", () => {
    const parsed = ClawlineConfigSchema.parse({ server: { cluSecret: null } });
    expect(parsed.server?.cluSecret).toBeNull();
  });

  it("rejects unknown keys inside server block", () => {
    expect(() =>
      ClawlineConfigSchema.parse({
        server: { unknownKey: true },
      }),
    ).toThrow();
  });
});
