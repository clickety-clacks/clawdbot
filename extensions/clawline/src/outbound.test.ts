import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setClawlineOutboundSender } from "./runtime/outbound.js";

describe("clawlineOutbound", () => {
  afterEach(() => {
    setClawlineOutboundSender(null);
  });

  it("uses the shared outbound text chunker", async () => {
    const { clawlineOutbound } = await import("./outbound.js");

    expect(clawlineOutbound.chunker?.("alpha\nbeta gamma", 8)).toEqual(
      chunkTextForOutbound("alpha\nbeta gamma", 8),
    );
  });

  it("attaches the channel to outbound sendText results", async () => {
    setClawlineOutboundSender(async ({ target }) => ({
      messageId: "msg-1",
      userId: target,
      deviceId: "device-1",
    }));

    const { clawlineOutbound } = await import("./outbound.js");
    await expect(
      clawlineOutbound.sendText?.({ to: "flynn:main", text: "hello" } as never),
    ).resolves.toEqual({
      channel: "clawline",
      messageId: "msg-1",
      meta: {
        userId: "flynn:main",
        deviceId: "device-1",
      },
    });
  });

  it("attaches the channel to outbound sendMedia results", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-2",
      userId: "flynn:main",
      deviceId: "device-2",
      assetIds: ["asset-1"],
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    await expect(
      clawlineOutbound.sendMedia?.({
        cfg: { channels: { clawline: { media: { maxUploadBytes: 1234 } } } },
        to: "flynn:main",
        text: "hello",
        mediaUrl: "https://example.com/image.png",
      } as never),
    ).resolves.toEqual({
      channel: "clawline",
      messageId: "msg-2",
      meta: {
        userId: "flynn:main",
        deviceId: "device-2",
        assetIds: ["asset-1"],
      },
    });
    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
    });
  });
});
