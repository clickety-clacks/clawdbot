import { describe, expect, it } from "vitest";

import { clawlinePlugin } from "./channel.js";

describe("clawline plugin", () => {
  it("builds tool context with user target", () => {
    const context = clawlinePlugin.threading?.buildToolContext?.({
      cfg: {} as any,
      accountId: "default",
      context: {
        From: "clawline:flynn-admin",
        OriginatingTo: "Flynn:main",
      },
      hasRepliedRef: { value: false },
    });

    expect(context?.currentChannelId).toBe("Flynn:main");
  });

  it("skips tool context when OriginatingTo is missing", () => {
    const context = clawlinePlugin.threading?.buildToolContext?.({
      cfg: {} as any,
      accountId: "default",
      context: {
        From: "clawline:flynn-personal",
      },
      hasRepliedRef: { value: false },
    });

    expect(context).toBeUndefined();
  });

  it("normalizes targets without lowercasing ids", () => {
    const normalize = clawlinePlugin.messaging?.normalizeTarget;
    expect(normalize?.("device:ABCDEF-1234")).toBe("device:ABCDEF-1234");
    expect(normalize?.("USER:Flynn")).toBe("user:Flynn");
  });
});
