import { describe, expect, it } from "vitest";
import { resolveSubscribedSessionKeys } from "./session-keys.js";

describe("resolveSubscribedSessionKeys", () => {
  it("returns the subscribed session keys when they are present", () => {
    expect(
      resolveSubscribedSessionKeys({
        sessionKey: "agent:main:clawline:flynn:main",
        sessionKeys: [undefined, "", "agent:main:main", "agent:main:clawline:flynn:main"],
      }),
    ).toEqual(["agent:main:main", "agent:main:clawline:flynn:main"]);
  });

  it("falls back to the legacy session key when no subscribed keys are present", () => {
    expect(
      resolveSubscribedSessionKeys({
        sessionKey: "agent:main:clawline:flynn:main",
        sessionKeys: [],
      }),
    ).toEqual(["agent:main:clawline:flynn:main"]);
  });

  it("returns an empty list when no broadcast key is available", () => {
    expect(
      resolveSubscribedSessionKeys({
        sessionKey: "   ",
        sessionKeys: [undefined, "", null],
      }),
    ).toEqual([]);
  });
});
