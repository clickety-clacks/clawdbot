import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<any>("openclaw/plugin-sdk");
  return {
    ...actual,
    sendClawlineOutboundMessage: vi.fn(),
  };
});

import { sendClawlineOutboundMessage } from "openclaw/plugin-sdk";
import { clawlineMessageActions } from "./actions.js";

describe("clawlineMessageActions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists stream actions when clawline is enabled", () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    expect(clawlineMessageActions.listActions({ cfg })).toEqual(
      expect.arrayContaining([
        "sendAttachment",
        "channel-list",
        "channel-create",
        "channel-edit",
        "channel-delete",
      ]),
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

    const result = await clawlineMessageActions.handleAction({
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

      const promise = clawlineMessageActions.handleAction({
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

  it("lists streams via REST with bearer auth", async () => {
    const cfg: OpenClawConfig = {
      channels: { clawline: { enabled: true, port: 19191, network: { bindAddress: "127.0.0.1" } } },
    };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          streams: [{ sessionKey: "agent:main:clawline:flynn:main", displayName: "Personal" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await clawlineMessageActions.handleAction({
      action: "channel-list",
      params: { token: "test-token" },
      cfg,
      accountId: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:19191/api/streams");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
    expect(result.details).toEqual({
      ok: true,
      status: 200,
      streams: [{ sessionKey: "agent:main:clawline:flynn:main", displayName: "Personal" }],
    });
  });

  it("creates, renames, and deletes streams with sessionKey identity", async () => {
    const cfg: OpenClawConfig = {
      channels: { clawline: { enabled: true, port: 19191, network: { bindAddress: "127.0.0.1" } } },
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            stream: {
              sessionKey: "agent:main:clawline:flynn:s_deadbeef",
              displayName: "Research",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            stream: {
              sessionKey: "agent:main:clawline:flynn:s_deadbeef",
              displayName: "Research v2",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deletedSessionKey: "agent:main:clawline:flynn:s_deadbeef",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const created = await clawlineMessageActions.handleAction({
      action: "channel-create",
      params: {
        token: "test-token",
        displayName: "Research",
        idempotencyKey: "req_create_stream_1",
      },
      cfg,
      accountId: null,
    });
    const sessionKey = "agent:main:clawline:flynn:s_deadbeef";
    const renamed = await clawlineMessageActions.handleAction({
      action: "channel-edit",
      params: {
        token: "test-token",
        channelId: sessionKey,
        displayName: "Research v2",
      },
      cfg,
      accountId: null,
    });
    const deleted = await clawlineMessageActions.handleAction({
      action: "channel-delete",
      params: {
        token: "test-token",
        channelId: sessionKey,
        idempotencyKey: "req_delete_stream_1",
      },
      cfg,
      accountId: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:19191/api/streams");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ displayName: "Research", idempotencyKey: "req_create_stream_1" }),
      }),
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://127.0.0.1:19191/api/streams/agent%3Amain%3Aclawline%3Aflynn%3As_deadbeef",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Research v2" }),
      }),
    );
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "x-clawline-user-action": "delete_stream",
        }),
        body: JSON.stringify({ idempotencyKey: "req_delete_stream_1" }),
      }),
    );

    expect(created.details).toEqual({
      ok: true,
      status: 201,
      idempotencyKey: "req_create_stream_1",
      stream: {
        sessionKey: "agent:main:clawline:flynn:s_deadbeef",
        displayName: "Research",
      },
    });
    expect(renamed.details).toEqual({
      ok: true,
      status: 200,
      stream: {
        sessionKey: "agent:main:clawline:flynn:s_deadbeef",
        displayName: "Research v2",
      },
    });
    expect(deleted.details).toEqual({
      ok: true,
      status: 200,
      idempotencyKey: "req_delete_stream_1",
      deletedSessionKey: "agent:main:clawline:flynn:s_deadbeef",
    });
  });

  it("returns structured stream API errors", async () => {
    const cfg: OpenClawConfig = { channels: { clawline: { enabled: true } } };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "stream_not_found", message: "Stream not found" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await clawlineMessageActions.handleAction({
      action: "channel-edit",
      params: {
        token: "test-token",
        channelId: "agent:main:clawline:flynn:s_deadbeef",
        displayName: "Rename",
      },
      cfg,
      accountId: null,
    });

    expect(result.details).toEqual({
      ok: false,
      status: 404,
      error: { code: "stream_not_found", message: "Stream not found" },
      body: { error: { code: "stream_not_found", message: "Stream not found" } },
    });
  });

  it("auto-resolves local token from state directory when no token in params", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawline-test-"));
    try {
      // Write a test JWT key and allowlist
      const testJwtKey = "test-jwt-signing-key-for-actions-test";
      fs.writeFileSync(path.join(tmpDir, "jwt.key"), testJwtKey + "\n");
      fs.writeFileSync(
        path.join(tmpDir, "allowlist.json"),
        JSON.stringify({
          version: 1,
          entries: [
            {
              deviceId: "TEST-DEVICE-ID",
              userId: "testuser",
              isAdmin: true,
              tokenDelivered: true,
              createdAt: Date.now(),
              lastSeenAt: Date.now(),
            },
          ],
        }),
      );

      const cfg: OpenClawConfig = {
        channels: {
          clawline: {
            enabled: true,
            port: 19191,
            network: { bindAddress: "127.0.0.1" },
            statePath: tmpDir,
          },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ deletedSessionKey: "agent:main:clawline:testuser:s_abc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      // Call channel-delete WITHOUT an explicit token in params
      const result = await clawlineMessageActions.handleAction({
        action: "channel-delete",
        params: {
          channelId: "agent:main:clawline:testuser:s_abc",
          idempotencyKey: "req_autotoken_test",
          // No token field — should auto-resolve from statePath
        },
        cfg,
        accountId: null,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The Authorization header must be set (auto-resolved from local state)
      const reqHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(reqHeaders["Authorization"]).toMatch(/^Bearer /);
      // Confirm the auto-token is a valid JWT signed with our test key
      const { default: jwt } = await import("jsonwebtoken");
      const decoded = jwt.verify(reqHeaders["Authorization"]!.slice(7), testJwtKey) as Record<
        string,
        unknown
      >;
      expect(decoded.sub).toBe("testuser");
      expect(decoded.deviceId).toBe("TEST-DEVICE-ID");
      expect(decoded.isAdmin).toBe(true);

      expect(result.details).toEqual(expect.objectContaining({ ok: true, status: 200 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
