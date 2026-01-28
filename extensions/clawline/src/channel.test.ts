import { describe, expect, it } from "vitest";

import { clawlinePlugin } from "./channel.js";

describe("clawline plugin", () => {
  it("builds tool context with user target", () => {
    const context = clawlinePlugin.threading?.buildToolContext?.({
      cfg: {} as any,
      accountId: "default",
      context: {
        From: "clawline:flynn-admin",
        OriginatingTo: "user:Flynn",
      },
      hasRepliedRef: { value: false },
    });

    expect(context?.currentChannelId).toBe("user:Flynn");
  });

  it("strips channel suffix when OriginatingTo is unavailable", () => {
    const context = clawlinePlugin.threading?.buildToolContext?.({
      cfg: {} as any,
      accountId: "default",
      context: {
        From: "clawline:flynn-personal",
      },
      hasRepliedRef: { value: false },
    });

    expect(context?.currentChannelId).toBe("user:flynn");
  });

  it("normalizes targets without lowercasing ids", () => {
    const normalize = clawlinePlugin.messaging?.normalizeTarget;
    expect(normalize?.("device:ABCDEF-1234")).toBe("device:ABCDEF-1234");
    expect(normalize?.("USER:Flynn")).toBe("user:Flynn");
  });
});
