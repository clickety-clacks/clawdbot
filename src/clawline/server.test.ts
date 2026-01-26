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

const decodeRawData = (data: WebSocket.RawData): string => {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
};

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
  pendingPath: string;
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
  const sessionStoreDir = path.join(root, "sessions");
  await fs.mkdir(sessionStoreDir, { recursive: true });
  const sessionStorePath = path.join(sessionStoreDir, "sessions.json");
  const allowlistPath = path.join(statePath, "allowlist.json");
  await fs.writeFile(
    allowlistPath,
    JSON.stringify({ version: 1, entries: initialAllowlist }, null, 2),
  );
  const pendingPath = path.join(statePath, "pending.json");
  await fs.writeFile(pendingPath, JSON.stringify({ version: 1, entries: [] }, null, 2));
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
    sessionStorePath,
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
    pendingPath,
    mediaPath,
    alertInstructionsPath,
    cleanup,
  };
}

type PairRequestOverrides = {
  claimedName?: string;
};

function createPairRequestPayload(deviceId: string, overrides: PairRequestOverrides = {}) {
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
    ...(overrides.claimedName ? { claimedName: overrides.claimedName } : {}),
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
        resolve(JSON.parse(decodeRawData(data)));
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

async function performPairRequest(
  port: number,
  deviceId: string,
  overrides: PairRequestOverrides = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  ws.send(JSON.stringify(createPairRequestPayload(deviceId, overrides)));
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

async function authenticateDevice(port: number, deviceId: string, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  ws.send(
    JSON.stringify({
      type: "auth",
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      token,
    }),
  );
  const auth = await waitForMessage(ws);
  if (!auth?.success) {
    ws.terminate();
    throw new Error(
      `Auth failed for ${deviceId}: ${typeof auth === "object" ? JSON.stringify(auth) : auth}`,
    );
  }
  return { ws, auth };
}

describe.sequential("clawline provider server", () => {
  it("reissues tokens for already approved devices", async () => {
    const deviceId = randomUUID();
    const originalLastSeen = Date.now() - 10_000;
    const entry: AllowlistEntry = {
      deviceId,
      claimedName: "Flynn",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      userId: "flynn",
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

  it("bootstraps Flynn as admin when first pairing uses that claimed name", async () => {
    const ctx = await setupTestServer();
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn " });
      expect(response).toMatchObject({
        success: true,
        userId: "flynn",
      });
      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        entries: AllowlistEntry[];
      };
      const entry = allowlist.entries.find((item) => item.deviceId === deviceId);
      expect(entry?.userId).toBe("flynn");
      expect(entry?.isAdmin).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("writes pending entries for non-admin claimants when no admin exists", async () => {
    const ctx = await setupTestServer();
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "QA Sim" });
      expect(response).toMatchObject({
        success: false,
        reason: "pair_pending",
      });
      const pending = JSON.parse(await fs.readFile(ctx.pendingPath, "utf8")) as {
        entries: { deviceId: string }[];
      };
      expect(pending.entries.some((entry) => entry.deviceId === deviceId)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("stores uploaded assets on disk", async () => {
    const ctx = await setupTestServer();
    try {
      const deviceId = randomUUID();
      const pairResponse = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn" });
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

  it("does not deliver admin channel messages to non-admin sessions", async () => {
    const adminDeviceId = randomUUID();
    const userDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "Test Device",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      tokenDelivered: true,
      createdAt: Date.now() - 1_000,
      lastSeenAt: Date.now() - 500,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: adminDeviceId,
        claimedName: "Flynn",
        userId: "flynn",
        isAdmin: true,
      },
      {
        ...baseEntry,
        deviceId: userDeviceId,
        claimedName: "QA Sim",
        userId: "qa_sim",
        isAdmin: false,
      },
    ]);
    const cleanupWs = async (...sockets: WebSocket[]) => {
      sockets.forEach((ws) => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
    };
    try {
      const adminPair = await performPairRequest(ctx.port, adminDeviceId);
      const userPair = await performPairRequest(ctx.port, userDeviceId);
      const { ws: adminWs } = await authenticateDevice(
        ctx.port,
        adminDeviceId,
        adminPair.token as string,
      );
      const { ws: userWs } = await authenticateDevice(
        ctx.port,
        userDeviceId,
        userPair.token as string,
      );

      const received: any[] = [];
      const listener = (data: WebSocket.RawData) => {
        received.push(JSON.parse(decodeRawData(data)));
      };
      userWs.on("message", listener);
      await new Promise((resolve) => setTimeout(resolve, 20));
      received.length = 0;

      adminWs.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          channelType: "admin",
          content: "secret-admin-update",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(0);
      userWs.off("message", listener);
      await cleanupWs(adminWs, userWs);
    } finally {
      await ctx.cleanup();
    }
  });

  it("includes isAdmin in auth_result based on allowlist entry", async () => {
    const adminDeviceId = randomUUID();
    const userDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
      tokenDelivered: true,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: adminDeviceId,
        claimedName: "Flynn",
        userId: "flynn",
        isAdmin: true,
      },
      {
        ...baseEntry,
        deviceId: userDeviceId,
        claimedName: "QA Sim",
        userId: "qa_sim",
        isAdmin: false,
      },
    ]);
    try {
      const adminPair = await performPairRequest(ctx.port, adminDeviceId);
      const userPair = await performPairRequest(ctx.port, userDeviceId);
      const { ws: adminWs, auth: adminAuth } = await authenticateDevice(
        ctx.port,
        adminDeviceId,
        adminPair.token as string,
      );
      const { ws: userWs, auth: userAuth } = await authenticateDevice(
        ctx.port,
        userDeviceId,
        userPair.token as string,
      );
      expect(adminAuth.isAdmin).toBe(true);
      expect(userAuth.isAdmin).toBe(false);
      adminWs.terminate();
      userWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("handles alert endpoint by waking gateway", async () => {
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
      expect(gatewayCallMock).toHaveBeenCalledTimes(3);
      const agentCall = gatewayCallMock.mock.calls[0]?.[0] as {
        params?: {
          message?: string;
          sessionKey?: string;
          deliver?: boolean;
          channel?: string;
        };
        method?: string;
      };
      const queueCall = gatewayCallMock.mock.calls[1]?.[0] as {
        params?: { text?: string };
      };
      const wakeCall = gatewayCallMock.mock.calls[2]?.[0] as {
        params?: { text?: string; mode?: string };
      };
      expect(agentCall?.method).toBe("agent");
      expect(agentCall?.params?.message).toBe("System Alert: [codex] Check on Flynn");
      expect(agentCall?.params?.sessionKey).toBeUndefined();
      expect(agentCall?.params?.deliver).toBe(true);
      expect(agentCall?.params?.channel).toBeUndefined();
      expect(queueCall?.params?.text).toBe("[codex] Check on Flynn");
      expect(wakeCall?.params?.text).toBe("[codex] Check on Flynn");
      expect(wakeCall?.params?.mode).toBe("now");
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
      const agentCall = gatewayCallMock.mock.calls[0]?.[0] as
        | { params?: { message?: string } }
        | undefined;
      const wakeCall = gatewayCallMock.mock.calls[2]?.[0] as
        | { params?: { text?: string } }
        | undefined;
      expect(agentCall?.params?.message).toBe(`System Alert: ${expected}`);
      expect(wakeCall?.params?.text).toBe(expected);
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
      const agentCall = gatewayCallMock.mock.calls[0]?.[0] as
        | { params?: { message?: string } }
        | undefined;
      const wakeCall = gatewayCallMock.mock.calls[2]?.[0] as
        | { params?: { text?: string } }
        | undefined;
      expect(agentCall?.params?.message).toBe(`System Alert: ${expected}`);
      expect(wakeCall?.params?.text).toBe(expected);
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
