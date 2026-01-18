import { Blob } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { FormData, fetch } from "undici";

import type { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { AllowlistEntry, Logger, ProviderServer } from "./domain.js";

const gatewayCallMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => gatewayCallMock(...args),
}));

const sendMessageMock = vi.fn();
vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import {
  createProviderServer,
  DEFAULT_ALERT_INSTRUCTIONS_TEXT,
  PROTOCOL_VERSION,
} from "./server.js";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testReplyResolver: typeof getReplyFromConfig = async () => ({ text: "ok" });

const testClawdbotConfig = {
  agents: { default: "main", list: [{ id: "main" }] },
  bindings: [],
} as ClawdbotConfig;

beforeEach(() => {
  gatewayCallMock.mockReset();
  gatewayCallMock.mockResolvedValue({ ok: true });
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({
    channel: "clawline",
    to: "flynn",
    via: "direct",
    mediaUrl: null,
  });
});

type TestServerContext = {
  server: ProviderServer;
  port: number;
  allowlistPath: string;
  mediaPath: string;
  alertInstructionsPath: string;
  cleanup: () => Promise<void>;
};

async function setupTestServer(
  initialAllowlist: AllowlistEntry[] = [],
  options: { alertInstructionsText?: string | null } = {},
): Promise<TestServerContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-server-test-"));
  const statePath = path.join(root, "state");
  const mediaPath = path.join(root, "media");
  await fs.mkdir(statePath, { recursive: true });
  await fs.mkdir(mediaPath, { recursive: true });
  await fs.mkdir(path.join(mediaPath, "assets"), { recursive: true });
  await fs.mkdir(path.join(mediaPath, "tmp"), { recursive: true });
  await fs.mkdir(path.join(root, "sessions"), { recursive: true });
  const allowlistPath = path.join(statePath, "allowlist.json");
  await fs.writeFile(
    allowlistPath,
    JSON.stringify({ version: 1, entries: initialAllowlist }, null, 2),
  );
  await fs.writeFile(
    path.join(statePath, "pending.json"),
    JSON.stringify({ version: 1, entries: [] }, null, 2),
  );
  await fs.writeFile(path.join(statePath, "denylist.json"), "[]");
  const alertInstructionsPath = path.join(root, "alert-instructions.md");
  if (options.alertInstructionsText !== null) {
    const contents = options.alertInstructionsText ?? "";
    await fs.writeFile(alertInstructionsPath, contents);
  }

  const server = await createProviderServer({
    config: {
      port: 0,
      statePath,
      media: { storagePath: mediaPath },
      alertInstructionsPath,
    },
    clawdbotConfig: testClawdbotConfig,
    replyResolver: testReplyResolver,
    logger: silentLogger,
    sessionStorePath: path.join(root, "sessions"),
  });
  await server.start();
  const cleanup = async () => {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  };
  return {
    server,
    port: server.getPort(),
    allowlistPath,
    mediaPath,
    alertInstructionsPath,
    cleanup,
  };
}

function createPairRequestPayload(deviceId: string) {
  return {
    type: "pair_request",
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    deviceInfo: {
      platform: "iOS",
      model: "iPhone",
      osVersion: "17.0",
      appVersion: "1.0",
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timeout"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    ws.once("open", handleOpen);
    ws.once("error", handleError);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleMessage = (data: WebSocket.RawData) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        resolve(JSON.parse(data.toString()));
      } catch (err) {
        reject(err);
      }
    };
    const handleError = (err: Error) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };
    const handleClose = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error("WebSocket closed before message"));
    };
    ws.once("message", handleMessage);
    ws.once("error", handleError);
    ws.once("close", handleClose);
  });
}

async function performPairRequest(port: number, deviceId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  ws.send(JSON.stringify(createPairRequestPayload(deviceId)));
  try {
    return await waitForMessage(ws);
  } finally {
    ws.terminate();
  }
}

async function uploadAsset(port: number, token: string, data: Buffer, mimeType: string) {
  const form = new FormData();
  form.set("file", new Blob([data], { type: mimeType }), "upload.bin");
  const response = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
  return response.json() as Promise<{ assetId: string; mimeType: string; size: number }>;
}

describe.sequential("clawline provider server", () => {
  it("reissues tokens for already approved devices", async () => {
    const deviceId = randomUUID();
    const originalLastSeen = Date.now() - 10_000;
    const entry: AllowlistEntry = {
      deviceId,
      claimedName: "Test Device",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      userId: "user_existing",
      isAdmin: true,
      tokenDelivered: true,
      createdAt: Date.now() - 60_000,
      lastSeenAt: originalLastSeen,
    };
    const ctx = await setupTestServer([entry]);
    try {
      const response = await performPairRequest(ctx.port, deviceId);
      expect(response).toMatchObject({
        type: "pair_result",
        success: true,
        userId: entry.userId,
      });
      expect(typeof response.token).toBe("string");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        entries: AllowlistEntry[];
      };
      const updated = allowlist.entries.find((item) => item.deviceId === deviceId);
      expect(updated).toBeTruthy();
      expect(updated?.lastSeenAt).not.toBeNull();
      expect((updated?.lastSeenAt ?? 0) > originalLastSeen).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("stores uploaded assets on disk", async () => {
    const ctx = await setupTestServer();
    try {
      const deviceId = randomUUID();
      const pairResponse = await performPairRequest(ctx.port, deviceId);
      expect(pairResponse.success).toBe(true);
      const token = pairResponse.token as string;
      const bytes = Buffer.from("sample-image-bytes");
      const upload = await uploadAsset(ctx.port, token, bytes, "image/png");
      expect(upload.assetId).toMatch(/^a_/);
      const assetPath = path.join(ctx.mediaPath, "assets", upload.assetId);
      const stored = await fs.readFile(assetPath);
      expect(stored.equals(bytes)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("handles alert endpoint by waking gateway and sending message", async () => {
    const ctx = await setupTestServer();
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      expect(gatewayCallMock).toHaveBeenCalledTimes(1);
      const wakeCall = gatewayCallMock.mock.calls[0]?.[0] as {
        params?: { text?: string; mode?: string };
      };
      expect(wakeCall?.params?.text).toBe("[codex] Check on Flynn");
      expect(wakeCall?.params?.mode).toBe("now");
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const sendCall = sendMessageMock.mock.calls[0]?.[0] as {
        channel?: string;
        to?: string;
        content?: string;
      };
      expect(sendCall?.channel).toBe("clawline");
      expect(sendCall?.to).toBe("flynn");
      expect(sendCall?.content).toBe("[codex] Check on Flynn");
    } finally {
      await ctx.cleanup();
    }
  });

  it("appends alert instructions text to alert payloads", async () => {
    const ctx = await setupTestServer([], { alertInstructionsText: "Follow up with Flynn ASAP." });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      const expected = "[codex] Check on Flynn\n\nFollow up with Flynn ASAP.";
      const wakeCall = gatewayCallMock.mock.calls[0]?.[0] as { params?: { text?: string } } | undefined;
      expect(wakeCall?.params?.text).toBe(expected);
      const sendCall = sendMessageMock.mock.calls[0]?.[0] as { content?: string } | undefined;
      expect(sendCall?.content).toBe(expected);
    } finally {
      await ctx.cleanup();
    }
  });

  it("initializes alert instructions file with default text when missing", async () => {
    const ctx = await setupTestServer([], { alertInstructionsText: null });
    try {
      const fileContents = (await fs.readFile(ctx.alertInstructionsPath, "utf8")).trim();
      expect(fileContents).toBe(DEFAULT_ALERT_INSTRUCTIONS_TEXT);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const expected = `[codex] Check on Flynn\n\n${DEFAULT_ALERT_INSTRUCTIONS_TEXT}`;
      const wakeCall = gatewayCallMock.mock.calls[0]?.[0] as { params?: { text?: string } } | undefined;
      expect(wakeCall?.params?.text).toBe(expected);
      const sendCall = sendMessageMock.mock.calls[0]?.[0] as { content?: string } | undefined;
      expect(sendCall?.content).toBe(expected);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 400 when alert payload is missing message", async () => {
    const ctx = await setupTestServer();
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "codex" }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe("invalid_message");
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });
});
