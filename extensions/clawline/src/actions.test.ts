import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime/outbound.js", () => {
  return {
    sendClawlineOutboundMessage: vi.fn(),
  };
});

import { clawlineMessageActions } from "./actions.js";
import { sendClawlineOutboundMessage } from "./runtime/outbound.js";

type ClawlineHandleAction = NonNullable<typeof clawlineMessageActions.handleAction>;
type ClawlineActionContext = Parameters<ClawlineHandleAction>[0];

async function runClawlineAction(
  ctx: Omit<ClawlineActionContext, "channel">,
): ReturnType<ClawlineHandleAction> {
  const handleAction = clawlineMessageActions.handleAction;
  if (!handleAction) {
    throw new Error("Clawline handleAction is not registered");
  }
  return await handleAction({
    channel: "clawline",
    ...ctx,
  });
}

describe("clawlineMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("describes stream actions when clawline is enabled", () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    expect(clawlineMessageActions.describeMessageTool({ cfg })?.actions).toEqual(
      expect.arrayContaining(["sendAttachment", "read"]),
    );
    expect(clawlineMessageActions.supportsAction?.({ action: "sendAttachment" })).toBe(true);
  });

  it("sendAttachment returns a small summary (no base64 attachment data)", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      userId: "flynn",
      deviceId: "device-1",
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: "AAAABASE64PAYLOAD",
        },
      ],
      assetIds: [],
    });

    const result = await runClawlineAction({
      action: "sendAttachment",
      params: {
        target: "flynn:main",
        buffer: "AAAABASE64PAYLOAD",
        mimeType: "application/vnd.clawline.interactive-html+json; charset=utf-8",
      },
      cfg,
      accountId: null,
    });

    expect(result.details).toEqual({
      ok: true,
      messageId: "msg-1",
      userId: "flynn",
      deviceId: "device-1",
      assetIds: [],
      attachmentCount: 1,
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
        },
      ],
    });

    expect(vi.mocked(sendClawlineOutboundMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendClawlineOutboundMessage).mock.calls[0]?.[0]).toEqual({
      target: "flynn:main",
      text: "",
      attachments: [
        { data: "AAAABASE64PAYLOAD", mimeType: "application/vnd.clawline.interactive-html+json" },
      ],
    });
  });

  it("sendAttachment times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
      vi.mocked(sendClawlineOutboundMessage).mockImplementationOnce(() => new Promise(() => {}));

      const promise = runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: "AAAABASE64PAYLOAD",
          mimeType: "application/vnd.clawline.terminal-session+json",
        },
        cfg,
        accountId: null,
      });

      // Attach a handler immediately so the timer-triggered rejection is never
      // reported as an unhandled rejection by the test runner.
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(15_000);
      await expect(promise).rejects.toThrow(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
