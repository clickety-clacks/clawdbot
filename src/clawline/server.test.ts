import BetterSqlite3 from "better-sqlite3";
import jwt from "jsonwebtoken";
import { Blob } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FormData, fetch, getGlobalDispatcher } from "undici";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { getReplyFromConfig } from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AllowlistEntry, Logger, ProviderServer } from "./domain.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../infra/system-events.js";

const gatewayCallMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => gatewayCallMock(...args),
}));

const enqueueAnnounceMock = vi.fn();
vi.mock("../agents/subagent-announce-queue.js", () => ({
  enqueueAnnounce: (...args: unknown[]) => enqueueAnnounceMock(...args),
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

const testOpenClawConfig = {
  agents: { default: "main", list: [{ id: "main" }] },
  bindings: [],
} as OpenClawConfig;

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

function createMessageQueue(ws: WebSocket) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const queued: any[] = [];
  // oxlint-disable-next-line typescript/no-explicit-any
  const waiters: Array<(value: any) => void> = [];

  const onMessage = (data: WebSocket.RawData) => {
    // oxlint-disable-next-line typescript/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(decodeRawData(data));
    } catch {
      parsed = decodeRawData(data);
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    queued.push(parsed);
  };

  ws.on("message", onMessage);

  return {
    next: () =>
      queued.length > 0
        ? Promise.resolve(queued.shift())
        : new Promise((resolve) => waiters.push(resolve)),
    dispose: () => ws.off("message", onMessage),
  };
}

beforeEach(() => {
  gatewayCallMock.mockReset();
  gatewayCallMock.mockResolvedValue({ ok: true });
  enqueueAnnounceMock.mockReset();
  enqueueAnnounceMock.mockReturnValue(true);
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({
    channel: "clawline",
    to: "flynn",
    via: "direct",
    mediaUrl: null,
  });
  resetSystemEventsForTest();
});

afterAll(async () => {
  // Undici keeps connections alive by default; close the global dispatcher so Vitest can exit.
  const dispatcher = getGlobalDispatcher() as unknown as { close?: () => unknown };
  if (typeof dispatcher.close === "function") {
    await dispatcher.close();
  }
});

type TestServerContext = {
  server: ProviderServer;
  port: number;
  allowlistPath: string;
  pendingPath: string;
  mediaPath: string;
  alertInstructionsPath: string;
  webRootPath: string;
  cleanup: () => Promise<void>;
};

const createAllowlistEntry = (overrides: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  deviceId: "cb76ad36-1e3b-4ff0-8249-ad8e4104bfa1",
  claimedName: "flynn",
  deviceInfo: {
    platform: "iOS",
    model: "iPhone",
    osVersion: "17.0",
    appVersion: "1.0",
  },
  userId: "flynn",
  isAdmin: true,
  tokenDelivered: true,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  ...overrides,
});

const createAuthHeader = async (ctx: TestServerContext, entry: AllowlistEntry): Promise<string> => {
  const statePath = path.dirname(ctx.allowlistPath);
  const jwtKey = (await fs.readFile(path.join(statePath, "jwt.key"), "utf8")).trim();
  const payload: jwt.JwtPayload = {
    sub: entry.userId,
    deviceId: entry.deviceId,
    isAdmin: entry.isAdmin,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, jwtKey, { algorithm: "HS256", issuer: "clawline" });
  return `Bearer ${token}`;
};

async function setupTestServer(
  initialAllowlist: AllowlistEntry[] = [],
  options: {
    alertInstructionsText?: string | null;
    webRootFollowSymlinks?: boolean;
    webRootPathRelative?: string;
    seedLegacyDatabase?: (dbPath: string) => Promise<void>;
    replyResolver?: typeof getReplyFromConfig;
    terminalTmux?: {
      mode?: "local" | "ssh";
      sshTarget?: string;
    };
  } = {},
): Promise<TestServerContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-server-test-"));
  const statePath = path.join(root, "state");
  const mediaPath = path.join(root, "media");
  await fs.mkdir(statePath, { recursive: true });
  await fs.mkdir(mediaPath, { recursive: true });
  const webRootPathRelative = options.webRootPathRelative ?? "www";
  if (path.isAbsolute(webRootPathRelative)) {
    throw new Error("setupTestServer: webRootPathRelative must be relative");
  }
  const webRootPath = path.join(root, webRootPathRelative);
  await fs.mkdir(webRootPath, { recursive: true });
  await fs.mkdir(path.join(webRootPath, "media"), { recursive: true });
  await fs.writeFile(path.join(webRootPath, "index.html"), "<html><body>root index</body></html>");
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
  const dbPath = path.join(statePath, "clawline.sqlite");
  if (typeof options.seedLegacyDatabase === "function") {
    await options.seedLegacyDatabase(dbPath);
  }
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
      webRootPath,
      webRoot: { followSymlinks: options.webRootFollowSymlinks === true },
      ...(options.terminalTmux
        ? {
            terminal: {
              tmux: {
                mode: options.terminalTmux.mode ?? "local",
                ssh: {
                  target: options.terminalTmux.sshTarget ?? "",
                },
              },
            },
          }
        : {}),
    },
    openClawConfig: testOpenClawConfig,
    replyResolver: options.replyResolver ?? testReplyResolver,
    logger: silentLogger,
    sessionStorePath,
  });
  await server.start();
  const cleanup = async () => {
    await server.stop();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code !== "ENOTEMPTY" && code !== "EBUSY") {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  return {
    server,
    port: server.getPort(),
    allowlistPath,
    pendingPath,
    mediaPath,
    alertInstructionsPath,
    webRootPath,
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

// oxlint-disable-next-line typescript/no-explicit-any
function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleMessage = (data: WebSocket.RawData) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      try {
        resolve(JSON.parse(decodeRawData(data)));
      } catch (err) {
        reject(err);
      }
    };
    const handleError = (err: Error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      reject(err);
    };
    const handleClose = () => {
      if (resolved) {
        return;
      }
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
  // Avoid a race where the server replies before we attach a message listener.
  const responsePromise = waitForMessage(ws);
  ws.send(JSON.stringify(createPairRequestPayload(deviceId, overrides)));
  try {
    return await responsePromise;
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

async function authenticateDevice(
  port: number,
  deviceId: string,
  token: string,
  options: { authPayload?: Record<string, unknown> } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  // Buffer messages to avoid races (auth_result, stream_snapshot, and session_info can arrive fast).
  const queue = createMessageQueue(ws);
  ws.send(
    JSON.stringify({
      type: "auth",
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      token,
      ...options.authPayload,
    }),
  );
  const auth = await queue.next();
  if (!auth?.success) {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Auth failed for ${deviceId}: ${typeof auth === "object" ? JSON.stringify(auth) : auth}`,
    );
  }
  const streamSnapshot = await queue.next();
  if (streamSnapshot?.type !== "stream_snapshot") {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Expected stream_snapshot after auth_result, got ${JSON.stringify(streamSnapshot)}`,
    );
  }
  let sessionInfo: unknown = null;
  if (Array.isArray(auth.features) && auth.features.includes("session_info")) {
    const next = await queue.next();
    if (next?.type !== "session_info") {
      queue.dispose();
      ws.terminate();
      throw new Error(`Expected session_info after stream_snapshot, got ${JSON.stringify(next)}`);
    }
    sessionInfo = next;
  }
  queue.dispose();
  return { ws, auth, streamSnapshot, sessionInfo };
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

  it("retains pending pairing entry after websocket disconnect", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer();
    try {
      const response = await performPairRequest(ctx.port, deviceId);
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
      const contents = await fs.readFile(ctx.pendingPath, "utf8");
      const pending = JSON.parse(contents);
      expect(pending.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ deviceId })]),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("queues a session alert when a pairing request becomes pending", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "QA Sim" });
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
      await vi.waitFor(() => {
        expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      });
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { prompt?: string; origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.prompt).toBe("System Alert: New device pending approval: qa sim (iOS)");
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
      expect(gatewayCallMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not bootstrap admin when no admin exists", async () => {
    const ctx = await setupTestServer();
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn " });
      expect(response).toMatchObject({ success: false, reason: "pair_pending" });
      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        entries: AllowlistEntry[];
      };
      const entry = allowlist.entries.find((item) => item.deviceId === deviceId);
      expect(entry).toBeUndefined();
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
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      isAdmin: true,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry]);
    try {
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

  it("keeps outbound interactive HTML attachments inline as documents", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        html: "<div>Hello</div>",
        metadata: { title: "Card", height: 80 },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.interactive-html+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts raw JSON terminal descriptors in outbound attachments", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const jsonPayload = JSON.stringify(descriptor);
      const expectedBase64 = Buffer.from(jsonPayload, "utf8").toString("base64");

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: jsonPayload,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: expectedBase64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts data URI terminal descriptors without blocking on tmux startup", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: {
        mode: "ssh",
        sshTarget: "nonexistent-host.invalid",
      },
    });
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const dataUri = `data:application/vnd.clawline.terminal-session+json;base64,${base64}`;

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: dataUri,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts data URI terminal descriptors with extra mime parameters", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: {
        mode: "ssh",
        sshTarget: "nonexistent-host.invalid",
      },
    });
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const dataUri =
        "data:application/vnd.clawline.terminal-session+json;charset=utf-8;base64," + base64;

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: dataUri,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("sends outbound document attachments even when inbound processing is still running", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      isAdmin: true,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry], {
      replyResolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return { text: "slow" };
      },
    });

    let ws: WebSocket | null = null;
    try {
      const pair = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn" });
      expect(pair.success).toBe(true);
      const authed = await authenticateDevice(ctx.port, deviceId, pair.token as string);
      ws = authed.ws;

      const inboundId = `c_${randomUUID()}`;
      ws.send(
        JSON.stringify({
          type: "message",
          id: inboundId,
          content: "trigger slow reply",
        }),
      );
      const ack = await waitForMessage(ws);
      expect(ack).toMatchObject({ type: "ack", id: inboundId });

      const descriptor = {
        version: 1,
        html: "<button>Hi</button>",
        metadata: { title: "Test" },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      const outbound = await Promise.race([
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.interactive-html+json",
            },
          ],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("outbound_send_timeout")), 800),
        ),
      ]);

      expect(outbound.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: base64,
        },
      ]);
    } finally {
      ws?.terminate();
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

      // oxlint-disable-next-line typescript/no-explicit-any
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
          sessionKey: "agent:main:main",
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

  it("prefers sessionKey routing for admin messages", async () => {
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

      // oxlint-disable-next-line typescript/no-explicit-any
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
          sessionKey: "agent:main:main",
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

  it("accepts messages without sessionKey for legacy clients", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer([
      {
        deviceId,
        claimedName: "Legacy Client",
        deviceInfo: {
          platform: "iOS",
          model: "iPhone",
          osVersion: "17.0",
          appVersion: "1.0",
        },
        userId: "legacy",
        isAdmin: false,
        tokenDelivered: true,
        createdAt: Date.now() - 10_000,
        lastSeenAt: Date.now() - 5_000,
      },
    ]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const { ws } = await authenticateDevice(ctx.port, deviceId, pair.token as string);
      const messageId = `c_${randomUUID()}`;
      const firstPromise = waitForMessage(ws);
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          content: "hello",
        }),
      );
      const first = await firstPromise;
      const ack = first?.type === "ack" ? first : await waitForMessage(ws);
      expect(ack).toMatchObject({ type: "ack", id: messageId });
      ws.terminate();
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
      const {
        ws: adminWs,
        auth: adminAuth,
        streamSnapshot: adminStreamSnapshot,
        sessionInfo: adminSessionInfo,
      } = await authenticateDevice(ctx.port, adminDeviceId, adminPair.token as string);
      const {
        ws: userWs,
        auth: userAuth,
        streamSnapshot: userStreamSnapshot,
        sessionInfo: userSessionInfo,
      } = await authenticateDevice(ctx.port, userDeviceId, userPair.token as string);
      expect(adminAuth.isAdmin).toBe(true);
      expect(userAuth.isAdmin).toBe(false);
      expect(adminAuth.features).toContain("session_info");
      expect(userAuth.features).toContain("session_info");
      expect(adminSessionInfo?.sessionKeys).toEqual([
        "agent:main:clawline:flynn:main",
        "agent:main:clawline:flynn:dm",
        "agent:main:main",
      ]);
      expect(userSessionInfo?.sessionKeys).toEqual([
        "agent:main:clawline:qa_sim:main",
        "agent:main:clawline:qa_sim:dm",
      ]);
      expect(adminStreamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            displayName: "Personal",
            kind: "main",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:dm",
            displayName: "DM",
            kind: "dm",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:main",
            displayName: "Admin",
            kind: "global_dm",
          }),
        ]),
      );
      expect(userStreamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:qa_sim:main",
            displayName: "Personal",
            kind: "main",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:clawline:qa_sim:dm",
            displayName: "DM",
            kind: "dm",
          }),
        ]),
      );
      adminWs.terminate();
      userWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("echoes terminal_bubbles_v1 in auth_result when client advertises support", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "feature_user",
      isAdmin: false,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, auth } = await authenticateDevice(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: {
            clientFeatures: ["terminal_bubbles_v1"],
            client: {
              id: "clawline-ios-tests",
              features: ["terminal_bubbles_v1"],
            },
          },
        },
      );
      expect(auth.features).toEqual(
        expect.arrayContaining(["session_info", "terminal_bubbles_v1"]),
      );
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("filters terminal attachments unless top-level clientFeatures advertises terminal_bubbles_v1", async () => {
    const noFeatureDeviceId = randomUUID();
    const withFeatureDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      userId: "feature_gate",
      isAdmin: false,
      tokenDelivered: true,
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: noFeatureDeviceId,
      },
      {
        ...baseEntry,
        deviceId: withFeatureDeviceId,
      },
    ]);
    try {
      const noFeaturePair = await performPairRequest(ctx.port, noFeatureDeviceId);
      const withFeaturePair = await performPairRequest(ctx.port, withFeatureDeviceId);
      const { ws: noFeatureWs } = await authenticateDevice(
        ctx.port,
        noFeatureDeviceId,
        noFeaturePair.token as string,
      );
      const { ws: withFeatureWs, auth: withFeatureAuth } = await authenticateDevice(
        ctx.port,
        withFeatureDeviceId,
        withFeaturePair.token as string,
        {
          authPayload: {
            clientFeatures: ["terminal_bubbles_v1"],
          },
        },
      );
      expect(withFeatureAuth.features).toEqual(
        expect.arrayContaining(["session_info", "terminal_bubbles_v1"]),
      );

      const descriptor = {
        version: 1,
        terminalSessionId: `ts_${randomUUID()}`,
        title: "gateway logs",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const noFeatureEventPromise = waitForMessage(noFeatureWs);
      const withFeatureEventPromise = waitForMessage(withFeatureWs);
      await ctx.server.sendMessage({
        target: "feature_gate",
        text: "",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      const noFeatureEvent = await noFeatureEventPromise;
      const withFeatureEvent = await withFeatureEventPromise;
      const withFeatureAttachments = Array.isArray(withFeatureEvent.attachments)
        ? withFeatureEvent.attachments
        : [];
      const noFeatureAttachments = Array.isArray(noFeatureEvent.attachments)
        ? noFeatureEvent.attachments
        : [];

      expect(
        withFeatureAttachments.some(
          (attachment) =>
            attachment?.type === "document" &&
            attachment?.mimeType === "application/vnd.clawline.terminal-session+json",
        ),
      ).toBe(true);
      expect(
        noFeatureAttachments.some(
          (attachment) =>
            attachment?.type === "document" &&
            attachment?.mimeType === "application/vnd.clawline.terminal-session+json",
        ),
      ).toBe(false);

      noFeatureWs.terminate();
      withFeatureWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("handles alert endpoint by waking gateway", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { prompt?: string; origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.prompt).toBe("System Alert: [codex] Check on Flynn");
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("routes alerts to personal session keys with explicit channel/to", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check personal channel",
          source: "codex",
          sessionKey: "agent:main:clawline:flynn:main",
        }),
      });
      expect(response.status).toBe(200);
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:clawline:flynn:main");
      expect(call?.item?.origin).toEqual({
        channel: "clawline",
        to: "agent:main:clawline:flynn:main",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("routes alerts to main session keys without explicit channel/to", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check main session",
          source: "codex",
          sessionKey: "agent:main:main",
        }),
      });
      expect(response.status).toBe(200);
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("prepends exec completion prompt when system events are pending", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    enqueueSystemEvent("Exec finished: voicemail", { sessionKey: "agent:main:main" });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      const expected = `System Alert: These items completed. Execute the next task, or identify what is blocking.\n\n[codex] Check on Flynn`;
      expect(call?.item?.prompt).toBe(expected);
    } finally {
      await ctx.cleanup();
    }
  });

  it("appends alert instructions text to alert payloads", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], {
      alertInstructionsText: "Follow up with Flynn ASAP.",
    });
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      const expected = "[codex] Check on Flynn\n\nFollow up with Flynn ASAP.";
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toBe(`System Alert: ${expected}`);
    } finally {
      await ctx.cleanup();
    }
  });

  it("initializes alert instructions file with default text when missing", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], { alertInstructionsText: null });
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const fileContents = (await fs.readFile(ctx.alertInstructionsPath, "utf8")).trim();
      expect(fileContents).toBe(DEFAULT_ALERT_INSTRUCTIONS_TEXT);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const expected = `[codex] Check on Flynn\n\n${DEFAULT_ALERT_INSTRUCTIONS_TEXT}`;
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toBe(`System Alert: ${expected}`);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 400 when alert payload is missing message", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ source: "codex" }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe("invalid_message");
      expect(enqueueAnnounceMock).not.toHaveBeenCalled();
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("sends stream_snapshot after auth_result and before replay", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const { ws, auth, streamSnapshot } = await authenticateDevice(
        ctx.port,
        deviceId,
        pair.token as string,
      );
      expect(auth.type).toBe("auth_result");
      expect(streamSnapshot.type).toBe("stream_snapshot");
      expect(Array.isArray(streamSnapshot.streams)).toBe(true);
      expect(streamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:dm",
            kind: "dm",
            displayName: "DM",
          }),
        ]),
      );
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("supports stream CRUD over REST and broadcasts stream events to all user sockets", async () => {
    const userId = "flynn";
    const firstDeviceId = randomUUID();
    const secondDeviceId = randomUUID();
    const now = Date.now();
    const baseEntry = {
      claimedName: "Flynn",
      deviceInfo: { platform: "iOS", model: "iPhone" },
      userId,
      isAdmin: false,
      tokenDelivered: true,
      createdAt: now - 5_000,
      lastSeenAt: now - 2_000,
    };
    const ctx = await setupTestServer([
      { ...baseEntry, deviceId: firstDeviceId },
      { ...baseEntry, deviceId: secondDeviceId },
    ]);
    try {
      const firstPair = await performPairRequest(ctx.port, firstDeviceId);
      const secondPair = await performPairRequest(ctx.port, secondDeviceId);
      const firstToken = firstPair.token as string;
      const secondToken = secondPair.token as string;
      const { ws: firstWs } = await authenticateDevice(ctx.port, firstDeviceId, firstToken);
      const { ws: secondWs } = await authenticateDevice(ctx.port, secondDeviceId, secondToken);
      const firstQueue = createMessageQueue(firstWs);
      const secondQueue = createMessageQueue(secondWs);

      const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(listResponse.status).toBe(200);
      const listPayload = (await listResponse.json()) as {
        streams: Array<{
          sessionKey: string;
          orderIndex: number;
          displayName: string;
          kind: string;
        }>;
      };
      expect(listPayload.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:dm",
            kind: "dm",
            displayName: "DM",
          }),
        ]),
      );

      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_stream_1",
          displayName: "Research",
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdPayload = (await createResponse.json()) as {
        stream: { sessionKey: string; kind: string };
      };
      expect(createdPayload.stream.kind).toBe("custom");
      expect(createdPayload.stream.sessionKey).toMatch(/:s_[0-9a-f]{8}$/);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_created",
        stream: { sessionKey: createdPayload.stream.sessionKey },
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_created",
        stream: { sessionKey: createdPayload.stream.sessionKey },
      });

      const encodedKey = encodeURIComponent(createdPayload.stream.sessionKey);
      const renameResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Research v2" }),
      });
      expect(renameResponse.status).toBe(200);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdPayload.stream.sessionKey, displayName: "Research v2" },
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdPayload.stream.sessionKey, displayName: "Research v2" },
      });

      const deleteResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_delete_stream_1" }),
      });
      expect(deleteResponse.status).toBe(200);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdPayload.stream.sessionKey,
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdPayload.stream.sessionKey,
      });

      const listAfterDelete = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      const listAfterDeletePayload = (await listAfterDelete.json()) as {
        streams: Array<{ sessionKey: string }>;
      };
      expect(
        listAfterDeletePayload.streams.some(
          (stream) => stream.sessionKey === createdPayload.stream.sessionKey,
        ),
      ).toBe(false);

      firstQueue.dispose();
      secondQueue.dispose();
      firstWs.terminate();
      secondWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts multiply-encoded stream session keys for rename and delete", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const queue = createMessageQueue(ws);

      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_double_encode",
          displayName: "Double Encode",
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdPayload = (await createResponse.json()) as {
        stream: { sessionKey: string };
      };
      const createdSessionKey = createdPayload.stream.sessionKey;
      await queue.next();

      const encodedKey = encodeURIComponent(createdSessionKey);
      const doubleEncodedKey = encodeURIComponent(encodedKey);
      const tripleEncodedKey = encodeURIComponent(doubleEncodedKey);

      const renameResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${doubleEncodedKey}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Renamed via double encode" }),
        },
      );
      expect(renameResponse.status).toBe(200);
      const renamedPayload = (await renameResponse.json()) as {
        stream: { sessionKey: string; displayName: string };
      };
      expect(renamedPayload.stream.sessionKey).toBe(createdSessionKey);
      expect(renamedPayload.stream.displayName).toBe("Renamed via double encode");
      expect(await queue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdSessionKey, displayName: "Renamed via double encode" },
      });

      const deleteResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${tripleEncodedKey}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_double_encode" }),
        },
      );
      expect(deleteResponse.status).toBe(200);
      const deletePayload = (await deleteResponse.json()) as { deletedSessionKey: string };
      expect(deletePayload.deletedSessionKey).toBe(createdSessionKey);
      expect(await queue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdSessionKey,
      });

      queue.dispose();
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns stream_not_found for malformed mutation keys instead of mutating built-ins", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;

      const renameResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent("%%%")}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Should not apply" }),
        },
      );
      expect(renameResponse.status).toBe(400);
      const renamePayload = (await renameResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(renamePayload.error.code).toBe("invalid_session_key");

      const deleteResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent("agent:bad:key")}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_bad_key_delete" }),
        },
      );
      expect(deleteResponse.status).toBe(404);
      const deletePayload = (await deleteResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(deletePayload.error.code).toBe("stream_not_found");
    } finally {
      await ctx.cleanup();
    }
  });

  it("enforces stream API edge cases for built-ins, idempotency reuse, and deleted stream sends", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listPayload = (await listResponse.json()) as {
        streams: Array<{ sessionKey: string }>;
      };
      const mainKey = listPayload.streams[0]?.sessionKey;
      expect(mainKey).toBe("agent:main:clawline:flynn:main");

      const renameBuiltIn = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(mainKey)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Nope" }),
        },
      );
      expect(renameBuiltIn.status).toBe(409);
      expect(await renameBuiltIn.json()).toEqual({
        error: {
          code: "built_in_stream_rename_forbidden",
          message: "Built-in streams cannot be renamed",
        },
      });

      const deleteBuiltIn = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(mainKey)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(deleteBuiltIn.status).toBe(409);
      expect(await deleteBuiltIn.json()).toEqual({
        error: {
          code: "built_in_stream_delete_forbidden",
          message: "Built-in streams cannot be deleted",
        },
      });

      const createOnce = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Scratch",
        }),
      });
      expect(createOnce.status).toBe(201);
      const created = (await createOnce.json()) as { stream: { sessionKey: string } };

      const createRetry = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Scratch",
        }),
      });
      expect(createRetry.status).toBe(201);
      expect(await createRetry.json()).toEqual(created);

      const createConflict = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Different",
        }),
      });
      expect(createConflict.status).toBe(409);
      expect(await createConflict.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "Idempotency key was already used",
        },
      });

      const deleteOnce = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(created.stream.sessionKey)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_once" }),
        },
      );
      expect(deleteOnce.status).toBe(200);

      const deleteRetry = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(created.stream.sessionKey)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_once" }),
        },
      );
      expect(deleteRetry.status).toBe(200);
      expect(await deleteRetry.json()).toEqual({
        deletedSessionKey: created.stream.sessionKey,
      });

      const crossOperationConflict = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_delete_once",
          displayName: "Other",
        }),
      });
      expect(crossOperationConflict.status).toBe(409);
      expect(await crossOperationConflict.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "Idempotency key was already used",
        },
      });

      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      ws.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          content: "to deleted stream",
          sessionKey: created.stream.sessionKey,
        }),
      );
      const wsResponse = await waitForMessage(ws);
      expect(wsResponse).toMatchObject({
        type: "error",
        code: "stream_not_found",
      });
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("migrates legacy events into stream metadata and backfills events.sessionKey", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const customSessionKey = "agent:main:clawline:flynn:s_deadbeef";
    const ctx = await setupTestServer([entry], {
      seedLegacyDatabase: async (dbPath) => {
        const db = new BetterSqlite3(dbPath);
        try {
          db.exec(`
            CREATE TABLE user_sequences (
              userId TEXT PRIMARY KEY,
              nextSequence INTEGER NOT NULL
            );
            CREATE TABLE events (
              id TEXT PRIMARY KEY,
              userId TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              originatingDeviceId TEXT,
              payloadJson TEXT NOT NULL,
              payloadBytes INTEGER NOT NULL,
              timestamp INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX idx_events_userId_sequence ON events(userId, sequence);
            CREATE INDEX idx_events_userId ON events(userId);
            CREATE TABLE messages (
              deviceId TEXT NOT NULL,
              userId TEXT NOT NULL,
              clientId TEXT NOT NULL,
              serverEventId TEXT NOT NULL,
              serverSequence INTEGER NOT NULL,
              content TEXT NOT NULL,
              contentHash TEXT NOT NULL,
              attachmentsHash TEXT NOT NULL,
              timestamp INTEGER NOT NULL,
              streaming INTEGER NOT NULL,
              ackSent INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (deviceId, clientId)
            );
            CREATE INDEX idx_messages_userId ON messages(userId);
            CREATE INDEX idx_messages_serverEventId ON messages(serverEventId);
            CREATE TABLE assets (
              assetId TEXT PRIMARY KEY,
              userId TEXT NOT NULL,
              mimeType TEXT NOT NULL,
              size INTEGER NOT NULL,
              createdAt INTEGER NOT NULL,
              uploaderDeviceId TEXT NOT NULL
            );
            CREATE INDEX idx_assets_userId ON assets(userId);
            CREATE INDEX idx_assets_createdAt ON assets(createdAt);
            CREATE TABLE message_assets (
              deviceId TEXT NOT NULL,
              clientId TEXT NOT NULL,
              assetId TEXT NOT NULL,
              PRIMARY KEY (deviceId, clientId, assetId),
              FOREIGN KEY (deviceId, clientId) REFERENCES messages(deviceId, clientId) ON DELETE CASCADE,
              FOREIGN KEY (assetId) REFERENCES assets(assetId) ON DELETE RESTRICT
            );
            CREATE INDEX idx_message_assets_assetId ON message_assets(assetId);
          `);
          const payload = JSON.stringify({
            type: "message",
            id: "s_00000000-0000-0000-0000-000000000001",
            role: "assistant",
            content: "legacy",
            timestamp: 1,
            streaming: false,
            sessionKey: customSessionKey,
          });
          db.prepare(
            `INSERT INTO events
              (id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            "s_00000000-0000-0000-0000-000000000001",
            "flynn",
            1,
            null,
            payload,
            Buffer.byteLength(payload, "utf8"),
            1,
          );
        } finally {
          db.close();
        }
      },
    });
    try {
      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const token = pair.token as string;
      const streamsResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(streamsResponse.status).toBe(200);
      const streamsPayload = (await streamsResponse.json()) as {
        streams: Array<{ sessionKey: string; kind: string; displayName: string }>;
      };
      expect(streamsPayload.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:dm",
            kind: "dm",
            displayName: "DM",
          }),
        ]),
      );
      expect(streamsPayload.streams.some((stream) => stream.sessionKey === customSessionKey)).toBe(
        true,
      );
      expect(
        streamsPayload.streams.some(
          (stream) => stream.sessionKey === customSessionKey && stream.kind === "custom",
        ),
      ).toBe(true);

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const userVersion = db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).toBe(2);
        const eventsColumns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{
          name: string;
        }>;
        expect(eventsColumns.some((col) => col.name === "eventType")).toBe(true);
        expect(eventsColumns.some((col) => col.name === "sessionKey")).toBe(true);
        const row = db
          .prepare(`SELECT sessionKey, eventType FROM events WHERE id = ?`)
          .get("s_00000000-0000-0000-0000-000000000001") as
          | { sessionKey: string; eventType: string }
          | undefined;
        expect(row?.sessionKey).toBe(customSessionKey);
        expect(row?.eventType).toBe("message");
      } finally {
        db.close();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("serves /www root index with caching headers and HEAD support", async () => {
    const ctx = await setupTestServer();
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("max-age=60");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("root index");
      const indexResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(await indexResponse.text()).toContain("root index");
      const headResponse = await fetch(`http://127.0.0.1:${ctx.port}/www`, { method: "HEAD" });
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe("");
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www blocks dotfiles, traversal, symlink escapes, and directories without index", async () => {
    const ctx = await setupTestServer();
    try {
      await fs.writeFile(path.join(ctx.webRootPath, ".secret"), "hidden");
      const dotResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/.secret`);
      expect(dotResponse.status).toBe(404);
      const traversalResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/www/../state/allowlist.json`,
      );
      expect(traversalResponse.status).toBe(404);
      const emptyDir = path.join(ctx.webRootPath, "emptydir");
      await fs.mkdir(emptyDir, { recursive: true });
      const emptyDirResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/emptydir/`);
      expect(emptyDirResponse.status).toBe(404);
      const subdirPath = path.join(ctx.webRootPath, "subdir");
      await fs.mkdir(subdirPath, { recursive: true });
      await fs.writeFile(path.join(subdirPath, "index.html"), "sub index");
      const subdirResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/subdir`);
      expect(await subdirResponse.text()).toBe("sub index");
      if (process.platform !== "win32") {
        const outsideFile = path.join(path.dirname(ctx.webRootPath), "outside.txt");
        await fs.writeFile(outsideFile, "leak");
        const linkPath = path.join(ctx.webRootPath, "leak");
        await fs.symlink(outsideFile, linkPath);
        const symlinkResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/leak`);
        expect(symlinkResponse.status).toBe(404);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www follows symlinks outside webroot when enabled (still blocks dotfiles)", async () => {
    if (process.platform === "win32") {
      return;
    }
    const ctx = await setupTestServer([], { webRootFollowSymlinks: true });
    try {
      const outsideFile = path.join(path.dirname(ctx.webRootPath), "outside.txt");
      await fs.writeFile(outsideFile, "leak");
      const linkPath = path.join(ctx.webRootPath, "leak");
      await fs.symlink(outsideFile, linkPath);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/leak`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("leak");

      const outsideDotfile = path.join(path.dirname(ctx.webRootPath), ".dotsecret");
      await fs.writeFile(outsideDotfile, "hidden");
      const dotLinkPath = path.join(ctx.webRootPath, "dotsecret");
      await fs.symlink(outsideDotfile, dotLinkPath);
      const dotResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/dotsecret`);
      expect(dotResponse.status).toBe(404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www serves from a dot-directory webRootPath (followSymlinks=false)", async () => {
    const ctx = await setupTestServer([], { webRootPathRelative: ".openclaw/workspace/www" });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("root index");
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: create then immediately delete child stream succeeds deterministically", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;

      // Rapid create+delete cycles to expose timing/normalization issues
      for (let i = 0; i < 5; i++) {
        const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: `req_create_t073_${i}`,
            displayName: `Test Stream ${i}`,
          }),
        });
        expect(createResponse.status).toBe(201);
        const created = (await createResponse.json()) as { stream: { sessionKey: string } };
        const sessionKey = created.stream.sessionKey;

        // Delete immediately (no delay) — this is the T073 repro condition
        const encodedKey = encodeURIComponent(sessionKey);
        const deleteResponse = await fetch(
          `http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ idempotencyKey: `req_delete_t073_${i}` }),
          },
        );
        expect(deleteResponse.status).toBe(200);
        const deleted = (await deleteResponse.json()) as { deletedSessionKey: string };
        expect(deleted.deletedSessionKey).toBe(sessionKey);

        // Verify stream is gone
        const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const list = (await listResponse.json()) as { streams: Array<{ sessionKey: string }> };
        expect(list.streams.find((s) => s.sessionKey === sessionKey)).toBeUndefined();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: concurrent create+delete from two sockets is serialized correctly", async () => {
    const deviceId1 = randomUUID();
    const deviceId2 = randomUUID();
    const entry1 = createAllowlistEntry({
      deviceId: deviceId1,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const entry2 = createAllowlistEntry({
      deviceId: deviceId2,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry1, entry2]);
    try {
      const pair1 = await performPairRequest(ctx.port, deviceId1);
      const pair2 = await performPairRequest(ctx.port, deviceId2);
      const token1 = pair1.token as string;
      const token2 = pair2.token as string;

      // Create from device 1
      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token1}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_concurrent",
          displayName: "Concurrent Test",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { stream: { sessionKey: string } };

      // Delete from device 2 immediately
      const encodedKey = encodeURIComponent(created.stream.sessionKey);
      const deleteResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token2}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_delete_concurrent" }),
      });
      expect(deleteResponse.status).toBe(200);
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: delete of already-deleted stream returns 404 without idempotency", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;

      // Create
      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_double_del",
          displayName: "Double Delete Test",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { stream: { sessionKey: string } };
      const encodedKey = encodeURIComponent(created.stream.sessionKey);

      // First delete
      const del1 = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_del_1" }),
      });
      expect(del1.status).toBe(200);

      // Second delete with different idempotency key → should be 404
      const del2 = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_del_2" }),
      });
      expect(del2.status).toBe(404);
      const payload = (await del2.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("stream_not_found");
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www serves from a dot-directory webRootPath (followSymlinks=true)", async () => {
    const ctx = await setupTestServer([], {
      webRootFollowSymlinks: true,
      webRootPathRelative: ".openclaw/workspace/www",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("root index");
    } finally {
      await ctx.cleanup();
    }
  });
});
