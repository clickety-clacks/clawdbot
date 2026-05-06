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
    const discovery = clawlineMessageActions.describeMessageTool({ cfg });
    expect(discovery?.actions).toEqual(expect.arrayContaining(["sendAttachment", "read"]));
    expect(clawlineMessageActions.supportsAction?.({ action: "sendAttachment" })).toBe(true);
    expect(discovery?.schema).toMatchObject({
      properties: {
        destination: expect.any(Object),
        title: expect.any(Object),
      },
    });
  });

  it("sendAttachment returns a small summary (no base64 attachment data)", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Hello</body></html>',
      }),
      "utf8",
    ).toString("base64");
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      userId: "flynn",
      deviceId: "device-1",
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: payload,
        },
      ],
      assetIds: [],
    });

    const result = await runClawlineAction({
      action: "sendAttachment",
      params: {
        target: "flynn:main",
        buffer: payload,
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
      attachments: [{ data: payload, mimeType: "application/vnd.clawline.interactive-html+json" }],
    });
  });

  it("sendAttachment rejects malformed interactive HTML descriptors before outbound delivery", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const malformed = Buffer.from(String.raw`{"version":1,"html":"bad \u201\V"}`, "utf8").toString(
      "base64",
    );

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: malformed,
          mimeType: "application/vnd.clawline.interactive-html+json",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow(/interactive HTML descriptor is not valid base64 JSON/i);

    expect(sendClawlineOutboundMessage).not.toHaveBeenCalled();
  });

  it("sendAttachment rejects interactive HTML descriptors with non-base64 suffixes", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const valid = Buffer.from(
      JSON.stringify({
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Hello</body></html>',
      }),
      "utf8",
    ).toString("base64");

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: `${valid}!`,
          mimeType: "application/vnd.clawline.interactive-html+json",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow(/interactive HTML descriptor is not valid base64 JSON/i);

    expect(sendClawlineOutboundMessage).not.toHaveBeenCalled();
  });

  it("sendAttachment rejects interactive HTML descriptors without viewport meta", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const missingViewport = Buffer.from(
      JSON.stringify({ version: 1, html: "<html><body>No viewport</body></html>" }),
      "utf8",
    ).toString("base64");

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: missingViewport,
          mimeType: "application/vnd.clawline.interactive-html+json",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow(/requires viewport meta tag/i);

    expect(sendClawlineOutboundMessage).not.toHaveBeenCalled();
  });

  it("sendAttachment rejects interactive HTML descriptors with custom CSP meta", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const customCSP = Buffer.from(
      JSON.stringify({
        version: 1,
        html: '<!doctype html><html><head><meta name=viewport content="width=device-width, initial-scale=1"><meta content="default-src \'none\'" http-equiv=Content-Security-Policy></head><body>Nope</body></html>',
      }),
      "utf8",
    ).toString("base64");

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: customCSP,
          mimeType: "application/vnd.clawline.interactive-html+json",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow(/must not include custom CSP/i);

    expect(sendClawlineOutboundMessage).not.toHaveBeenCalled();
  });

  it("sendAttachment times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Hello</body></html>',
        }),
        "utf8",
      ).toString("base64");
      vi.mocked(sendClawlineOutboundMessage).mockImplementationOnce(() => new Promise(() => {}));

      const promise = runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: payload,
          mimeType: "application/vnd.clawline.interactive-html+json",
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

  it("sendAttachment rejects legacy terminal bubble descriptors without destination routing", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const legacyDescriptor = Buffer.from(
      JSON.stringify({
        version: 1,
        terminalSessionId: "term_legacy",
        title: "legacy terminal",
      }),
      "utf8",
    ).toString("base64");

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          buffer: legacyDescriptor,
          mimeType: "application/vnd.clawline.terminal-session+json",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow("Clawline terminal bubbles now require version 2 with destination.address");

    expect(vi.mocked(sendClawlineOutboundMessage)).not.toHaveBeenCalled();
  });

  it("sendAttachment accepts version 2 terminal bubble descriptors with destination routing", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    const descriptor = Buffer.from(
      JSON.stringify({
        version: 2,
        terminalSessionId: "term_v2",
        title: "eezo",
        destination: { address: "mike@eezo" },
      }),
      "utf8",
    ).toString("base64");
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-term-v2",
      userId: "flynn",
      deviceId: "device-1",
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: descriptor,
        },
      ],
      assetIds: [],
    });

    const result = await runClawlineAction({
      action: "sendAttachment",
      params: {
        target: "flynn:main",
        buffer: descriptor,
        mimeType: "application/vnd.clawline.terminal-session+json",
      },
      cfg,
      accountId: null,
    });

    expect(result.details).toEqual({
      ok: true,
      messageId: "msg-term-v2",
      userId: "flynn",
      deviceId: "device-1",
      assetIds: [],
      attachmentCount: 1,
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
        },
      ],
    });
    expect(vi.mocked(sendClawlineOutboundMessage)).toHaveBeenCalledTimes(1);
  });

  it("sendAttachment builds a version 2 terminal bubble descriptor from structured destination routing", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-term-request",
      userId: "flynn",
      deviceId: "device-1",
      attachments: [
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: "placeholder",
        },
      ],
      assetIds: [],
    });

    await runClawlineAction({
      action: "sendAttachment",
      params: {
        target: "flynn:main",
        mimeType: "application/vnd.clawline.terminal-session+json",
        destination: {
          address: "mike@eezo",
        },
      },
      cfg,
      accountId: null,
    });

    const call = vi.mocked(sendClawlineOutboundMessage).mock.calls[0]?.[0];
    const attachment = call?.attachments?.[0];
    expect(call?.target).toBe("flynn:main");
    expect(call?.text).toBe("");
    expect(attachment?.mimeType).toBe("application/vnd.clawline.terminal-session+json");
    expect(typeof attachment?.data).toBe("string");

    const descriptor = JSON.parse(
      Buffer.from((attachment as { data: string }).data, "base64").toString("utf8"),
    ) as {
      version: number;
      terminalSessionId: string;
      title?: string;
      destination?: { address?: string };
      provider?: { wsPath?: string };
      auth?: { mode?: string };
      capabilities?: {
        interactive?: boolean;
        supportsBinaryFrames?: boolean;
        supportsResize?: boolean;
        supportsDetach?: boolean;
      };
    };
    expect(descriptor.version).toBe(2);
    expect(descriptor.terminalSessionId).toMatch(/^term_[a-f0-9]+$/);
    expect(descriptor.title).toBe("mike@eezo");
    expect(descriptor.destination?.address).toBe("mike@eezo");
    expect(descriptor.provider?.wsPath).toBe("/ws/terminal");
    expect(descriptor.auth?.mode).toBe("chat_token");
    expect(descriptor.capabilities).toMatchObject({
      interactive: true,
      supportsBinaryFrames: true,
      supportsResize: true,
      supportsDetach: true,
    });
  });

  it("sendAttachment rejects terminal bubble requests that supply both destination routing and a raw descriptor", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          mimeType: "application/vnd.clawline.terminal-session+json",
          buffer: "Zm9v",
          destination: {
            address: "mike@eezo",
          },
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toThrow(
      "Clawline terminal bubble request cannot include both destination routing and a raw descriptor buffer",
    );
  });
});
