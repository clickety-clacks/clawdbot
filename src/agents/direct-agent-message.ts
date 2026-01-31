import crypto from "node:crypto";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { callGateway } from "../gateway/call.js";
import {
  type DeliveryContext,
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.js";
import { isEmbeddedPiRunActive, queueEmbeddedPiMessage } from "./pi-embedded.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";

export type DirectAgentMessageResult = {
  outcome: "steered" | "queued" | "sent" | "error";
  error?: string;
};

export async function sendDirectAgentMessage(params: {
  sessionKey: string;
  message: string;
  deliveryContext?: DeliveryContext;
  summaryLine?: string;
  timeoutMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}): Promise<DirectAgentMessageResult> {
  const log = params.log ?? (() => {});
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[params.sessionKey];
    const hasEntry = Boolean(entry);
    const sessionId = entry?.sessionId;

    log("direct_agent_resolve", { sessionKey: params.sessionKey, hasEntry, sessionId });

    // Merge explicit deliveryContext (primary) with session store context (fallback).
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const sessionContext = deliveryContextFromSession(entry);
    const merged = mergeDeliveryContext(explicitContext, sessionContext);

    const channel = merged?.channel;
    const to = merged?.to;
    const accountId = merged?.accountId;
    const threadId =
      merged?.threadId != null && merged.threadId !== "" ? String(merged.threadId) : undefined;

    // No session entry → skip steer/queue, send directly.
    if (!sessionId) {
      await callGateway({
        method: "agent",
        params: {
          sessionKey: params.sessionKey,
          message: params.message,
          deliver: true,
          channel,
          accountId,
          to,
          threadId,
          idempotencyKey: crypto.randomUUID(),
        },
        expectFinal: true,
        timeoutMs: params.timeoutMs ?? 60_000,
      });
      log("direct_agent_sent", { sessionKey: params.sessionKey, channel, to });
      return { outcome: "sent" };
    }

    // Resolve queue settings for steer/queue decision.
    const queueSettings = resolveQueueSettings({
      cfg,
      channel: entry?.channel ?? entry?.lastChannel,
      sessionEntry: entry,
    });
    const isActive = isEmbeddedPiRunActive(sessionId);

    // Steer attempt: inject into an active run's input stream.
    const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
    if (shouldSteer) {
      const steered = queueEmbeddedPiMessage(sessionId, params.message);
      if (steered) {
        log("direct_agent_steered", { sessionKey: params.sessionKey, sessionId });
        return { outcome: "steered" };
      }
    }

    // Queue: agent is busy and mode supports queuing.
    const shouldQueue =
      queueSettings.mode === "followup" ||
      queueSettings.mode === "collect" ||
      queueSettings.mode === "steer-backlog" ||
      queueSettings.mode === "interrupt" ||
      queueSettings.mode === "steer";
    if (isActive && shouldQueue) {
      enqueueAnnounce({
        key: params.sessionKey,
        item: {
          prompt: params.message,
          summaryLine: params.summaryLine,
          enqueuedAt: Date.now(),
          sessionKey: params.sessionKey,
          origin: merged,
        },
        settings: queueSettings,
        send: sendQueued,
      });
      log("direct_agent_queued", { sessionKey: params.sessionKey, sessionId });
      return { outcome: "queued" };
    }

    // Agent not busy: send directly with expectFinal.
    await callGateway({
      method: "agent",
      params: {
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: true,
        channel,
        accountId,
        to,
        threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: params.timeoutMs ?? 60_000,
    });
    log("direct_agent_sent", { sessionKey: params.sessionKey, channel, to });
    return { outcome: "sent" };
  } catch (err) {
    log("direct_agent_error", { error: String(err) });
    return { outcome: "error", error: String(err) };
  }
}

async function sendQueued(item: AnnounceQueueItem) {
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  await callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: origin?.channel,
      accountId: origin?.accountId,
      to: origin?.to,
      threadId,
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
    },
    expectFinal: true,
    timeoutMs: 60_000,
  });
}
