import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<any>("openclaw/plugin-sdk");
  return {
    ...actual,
    sendClawlineOutboundMessage: vi.fn(),
  };
});

import { sendClawlineOutboundMessage } from "openclaw/plugin-sdk";
import { clawlineOutbound } from "./outbound.js";

describe("clawlineOutbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes mediaUrl through to the provider instead of base64-wrapping it in the extension", async () => {
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      userId: "flynn",
      assetIds: ["a_123"],
    });

    const result = await clawlineOutbound.sendMedia({
      cfg: { channels: { clawline: { media: { maxUploadBytes: 123 } } } },
      to: "flynn:main",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: null,
      deps: null as never,
    });

    expect(vi.mocked(sendClawlineOutboundMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendClawlineOutboundMessage).mock.calls[0]?.[0]).toEqual({
      target: "flynn:main",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
    });
    expect(result).toEqual({
      channel: "clawline",
      messageId: "msg-1",
      meta: {
        userId: "flynn",
        deviceId: undefined,
        assetIds: ["a_123"],
      },
    });
  });
});
