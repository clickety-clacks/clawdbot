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

  it("shares sender state across independently loaded runtime chunks", async () => {
    const ts = Date.now().toString(36);
    const outboundUrl = new URL("./outbound.ts", import.meta.url).href;

    const chunkA = await import(/* @vite-ignore */ `${outboundUrl}?chunk=bridge-a-${ts}`);
    const chunkB = await import(/* @vite-ignore */ `${outboundUrl}?chunk=bridge-b-${ts}`);

    chunkA.setClawlineOutboundSender(async (params: { target: string }) => ({
      messageId: `msg-${ts}`,
      userId: params.target,
      deviceId: "device-cross-chunk",
    }));

    expect(chunkB.hasClawlineOutboundSender()).toBe(true);
    await expect(
      chunkB.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "cross chunk hello",
      }),
    ).resolves.toEqual({
      messageId: `msg-${ts}`,
      userId: "flynn:main",
      deviceId: "device-cross-chunk",
    });
  });
});
