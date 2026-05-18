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
        terminalSession: expect.any(Object),
        title: expect.any(Object),
        terminalSessionId: expect.any(Object),
        tmuxSessionName: expect.any(Object),
      },
    });
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
    ).rejects.toThrow(
      "Clawline terminal bubbles now require version 2 or 3 with destination.address",
    );

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

  it("sendAttachment builds a version 3 terminal bubble descriptor from structured destination routing", async () => {
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
      terminalSession?: { name?: string; provisioning?: string };
      provider?: { wsPath?: string };
      auth?: { mode?: string };
      capabilities?: {
        interactive?: boolean;
        supportsBinaryFrames?: boolean;
        supportsResize?: boolean;
        supportsDetach?: boolean;
      };
    };
    expect(descriptor.version).toBe(3);
    expect(descriptor.terminalSessionId).toMatch(/^termmsg_[a-f0-9]+$/);
    expect(descriptor.title).toBe("mike@eezo");
    expect(descriptor.destination?.address).toBe("mike@eezo");
    expect(descriptor.terminalSession).toBeUndefined();
    expect(descriptor.provider?.wsPath).toBe("/ws/terminal");
    expect(descriptor.auth?.mode).toBe("chat_token");
    expect(descriptor.capabilities).toMatchObject({
      interactive: true,
      supportsBinaryFrames: true,
      supportsResize: true,
      supportsDetach: true,
    });
  });

  it("sendAttachment builds a structured terminal bubble for a caller-supplied terminal session name", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-existing-term-request",
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
        terminalSession: { name: "flynn-existing-agent" },
        title: "existing agent on eezo",
        destination: {
          address: "mike@eezo",
        },
      },
      cfg,
      accountId: null,
    });

    const call = vi.mocked(sendClawlineOutboundMessage).mock.calls[0]?.[0];
    const attachment = call?.attachments?.[0];
    const descriptor = JSON.parse(
      Buffer.from((attachment as { data: string }).data, "base64").toString("utf8"),
    ) as {
      version: number;
      terminalSessionId: string;
      title?: string;
      destination?: { address?: string };
      terminalSession?: { name?: string; provisioning?: string };
      provider?: { wsPath?: string };
      auth?: { mode?: string };
    };
    expect(descriptor).toMatchObject({
      version: 3,
      title: "existing agent on eezo",
      destination: { address: "mike@eezo" },
      terminalSession: { name: "flynn-existing-agent", provisioning: "attach_or_create" },
      provider: { wsPath: "/ws/terminal" },
      auth: { mode: "chat_token" },
    });
    expect(descriptor.terminalSessionId).toMatch(/^termmsg_[a-f0-9]+$/);
    expect(descriptor.terminalSessionId).not.toBe("flynn-existing-agent");
  });

  it("sendAttachment accepts matching compatibility aliases for the terminal session name", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    vi.mocked(sendClawlineOutboundMessage).mockResolvedValueOnce({
      messageId: "msg-matching-aliases",
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
        destination: { address: "mike@eezo" },
        terminalSession: { name: "same-agent" },
        terminalSessionId: "same-agent",
        tmuxSessionName: "same-agent",
      },
      cfg,
      accountId: null,
    });

    const call = vi.mocked(sendClawlineOutboundMessage).mock.calls[0]?.[0];
    const attachment = call?.attachments?.[0];
    const descriptor = JSON.parse(
      Buffer.from((attachment as { data: string }).data, "base64").toString("utf8"),
    ) as {
      terminalSession?: { name?: string };
    };
    expect(descriptor.terminalSession?.name).toBe("same-agent");
  });

  it("sendAttachment rejects conflicting structured terminal session aliases with target details", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };

    await expect(
      runClawlineAction({
        action: "sendAttachment",
        params: {
          target: "flynn:main",
          mimeType: "application/vnd.clawline.terminal-session+json",
          destination: { address: "mike@eezo" },
          terminalSession: { name: "named-session" },
          tmuxSessionName: "different-session",
        },
        cfg,
        accountId: null,
      }),
    ).rejects.toMatchObject({
      details: {
        error: "clawline_terminal_bubble_request_invalid",
        destination: { address: "mike@eezo" },
        terminalSession: { name: "named-session" },
      },
    });
    expect(vi.mocked(sendClawlineOutboundMessage)).not.toHaveBeenCalled();
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
