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

  it("keeps generated inline image data URLs intact for attachment extraction", async () => {
    const { clawlineOutbound } = await import("./outbound.js");
    const dataUrl = `data:image/png;base64,${"QUJD".repeat(1200)}`;
    const text = `![generated image](${dataUrl})`;

    expect(clawlineOutbound.chunker?.(text, 4000)).toEqual([text]);
  });

  it("chunks long prose around generated inline image data URLs", async () => {
    const { clawlineOutbound } = await import("./outbound.js");
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const text = `${"alpha ".repeat(20)}\n\n![generated image](${dataUrl})`;

    const chunks = clawlineOutbound.chunker?.(text, 40) ?? [];

    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toContain(`![generated image](${dataUrl})`);
    expect(chunks.slice(1).join(" ")).not.toContain("data:image/png");
    expect(chunks.map((chunk) => chunk.replace(`\n\n![generated image](${dataUrl})`, ""))).toEqual(
      chunkTextForOutbound("alpha ".repeat(20).trim(), 40),
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

  it("sends generated inline image data URLs as Clawline attachments", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-image",
      userId: "flynn:main",
      deviceId: "device-image",
      assetIds: ["asset-image"],
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    await expect(
      clawlineOutbound.sendText?.({
        to: "flynn:main",
        text: "Here is the render:\n\n![generated image](data:image/png;base64,aGVs\nbG8=)",
      } as never),
    ).resolves.toEqual({
      channel: "clawline",
      messageId: "msg-image",
      meta: {
        userId: "flynn:main",
        deviceId: "device-image",
        assetIds: ["asset-image"],
      },
    });
    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text: "Here is the render:",
      attachments: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
  });

  it("extracts mixed markdown and bare generated image data URLs", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-mixed-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text:
        "First ![generated image](data:image/png;base64,aGVsbG8=) " +
        "second data:image/jpeg;base64,d29ybGQ=",
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text: "First  second",
      attachments: [
        { mimeType: "image/png", data: "aGVsbG8=" },
        { mimeType: "image/jpeg", data: "d29ybGQ=" },
      ],
    });
  });

  it("extracts line-wrapped bare generated image data URLs as one attachment", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-wrapped-bare-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text: "Render:\ndata:image/png;base64,aGVs\nbG8=",
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text: "Render:",
      attachments: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
  });

  it("leaves invalid markdown image data URLs in text", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-invalid-markdown-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    const text = "Bad render: ![generated image](data:image/png;base64,aGVsbG8!)";
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text,
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text,
      attachments: undefined,
    });
  });

  it("leaves non-strict bare image data URLs in text", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-nonstrict-bare-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    const text = "Bad render: data:image/png;base64,aGVsbG8";
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text,
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text,
      attachments: undefined,
    });
  });

  it("leaves bare image data URLs with invalid suffixes in text", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-invalid-suffix-bare-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    const text = "Bad render: data:image/png;base64,aGVsbG8=!";
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text,
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text,
      attachments: undefined,
    });
  });

  it("leaves whitespace-separated invalid bare image data URLs in text", async () => {
    const sender = vi.fn(async () => ({
      messageId: "msg-invalid-spaced-bare-image",
      userId: "flynn:main",
    }));
    setClawlineOutboundSender(sender);

    const { clawlineOutbound } = await import("./outbound.js");
    const text = "Bad render: data:image/png;base64,aGVs bG8=";
    await clawlineOutbound.sendText?.({
      to: "flynn:main",
      text,
    } as never);

    expect(sender).toHaveBeenCalledWith({
      target: "flynn:main",
      text,
      attachments: undefined,
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
