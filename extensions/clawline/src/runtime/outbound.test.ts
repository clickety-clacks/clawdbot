import { afterEach, describe, expect, it } from "vitest";
import {
  hasClawlineOutboundSender,
  sendClawlineOutboundMessage,
  setClawlineOutboundSender,
} from "./outbound.js";

describe("clawline outbound bridge", () => {
  afterEach(() => {
    setClawlineOutboundSender(null);
  });

  it("rejects sends when the extension runtime has not registered a sender", async () => {
    await expect(
      sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "hello",
      }),
    ).rejects.toThrow("clawline outbound delivery is not available (service not running)");
    expect(hasClawlineOutboundSender()).toBe(false);
  });

  it("routes sends through the extension-owned sender bridge", async () => {
    setClawlineOutboundSender(async (params) => ({
      messageId: "msg-1",
      userId: params.target,
      deviceId: "device-1",
    }));

    await expect(
      sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "hello",
      }),
    ).resolves.toEqual({
      messageId: "msg-1",
      userId: "flynn:main",
      deviceId: "device-1",
    });
    expect(hasClawlineOutboundSender()).toBe(true);
  });
});
