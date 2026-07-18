import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import {
  ForemanTaskFlowController,
  type ForemanAssignmentInput,
  type ForemanAttemptPhase,
  type ForemanPaneRef,
  type ForemanWorkerEvent,
} from "./foreman-controller.js";
import type { ManagedTaskFlowRecord } from "./runtime/runtime-taskflow.types.js";

const execFileAsync = promisify(execFile);

export type ForemanWorkerRegistration = {
  hostId: string;
  baseUrl: string;
  bearerToken?: string;
};

export type ForemanSubmitRequest = {
  flowId: string;
  attemptId: string;
  prompt: string;
  idempotencyKey: string;
  expectedFlowRevision: number;
  idleAfterMs: number;
  submitAckTimeoutMs: number;
  controllerEventsUrl: string;
  controllerBearerToken?: string;
};

export type ForemanSubmitOkResponse = {
  ok: true;
  flowId: string;
  attemptId: string;
  hostId: string;
  agentName: string;
  phase: Extract<
    ForemanAttemptPhase,
    "submitted_to_pty" | "accepted" | "running" | "waiting_for_owner_check"
  >;
  submittedAt: number;
  startedWorkAt?: number;
};

export type ForemanSubmitErrorResponse = {
  ok: false;
  code:
    | "host_unreachable"
    | "worker_protocol_error"
    | "session_not_found"
    | "agent_not_detected"
    | "agent_busy"
    | "prompt_submit_failed"
    | "prompt_not_accepted";
  retryable: boolean;
  recommendedAction: "retry" | "steer_or_replace" | "ask_owner";
  message: string;
};

export type ForemanSubmitResponse = ForemanSubmitOkResponse | ForemanSubmitErrorResponse;

export type ForemanSubmitResult = ForemanSubmitResponse & {
  flow: ManagedTaskFlowRecord;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type ForemanRouteSubmitBody = ForemanAssignmentInput & {
  idleAfterMs?: number;
  submitAckTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readHttpJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeHttpJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function requireForemanState(flow: ManagedTaskFlowRecord): {
  activeAttemptId: string;
  attempts: Record<
    string,
    {
      idempotencyKey: string;
      phase: ForemanAttemptPhase;
      submittedAt?: number;
      startedWorkAt?: number;
    }
  >;
} {
  const state = flow.stateJson;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Foreman flow state is missing.");
  }
  const candidate = state as {
    activeAttemptId?: unknown;
    attempts?: unknown;
  };
  if (typeof candidate.activeAttemptId !== "string" || !candidate.attempts) {
    throw new Error("Foreman flow state has no active attempt.");
  }
  return candidate as {
    activeAttemptId: string;
    attempts: Record<
      string,
      {
        idempotencyKey: string;
        phase: ForemanAttemptPhase;
        submittedAt?: number;
        startedWorkAt?: number;
      }
    >;
  };
}

function submitResponseFromExistingFlow(
  flow: ManagedTaskFlowRecord,
): ForemanSubmitOkResponse | null {
  const state = requireForemanState(flow);
  const attempt = state.attempts[state.activeAttemptId];
  if (
    !attempt ||
    (attempt.phase !== "submitted_to_pty" &&
      attempt.phase !== "accepted" &&
      attempt.phase !== "running" &&
      attempt.phase !== "waiting_for_owner_check")
  ) {
    return null;
  }
  const flowState = flow.stateJson as {
    attempts: Record<string, { hostId: string; agentName: string }>;
  };
  const ownerAttempt = flowState.attempts[state.activeAttemptId];
  return {
    ok: true,
    flowId: flow.flowId,
    attemptId: state.activeAttemptId,
    hostId: ownerAttempt.hostId,
    agentName: ownerAttempt.agentName,
    phase: attempt.phase,
    submittedAt: attempt.submittedAt ?? flow.createdAt,
    ...(attempt.startedWorkAt ? { startedWorkAt: attempt.startedWorkAt } : {}),
  };
}

export class ForemanWorkerHttpClient {
  constructor(
    private readonly params: {
      fetch?: FetchLike;
    } = {},
  ) {}

  async submit(
    worker: ForemanWorkerRegistration,
    agentName: string,
    body: ForemanSubmitRequest,
  ): Promise<ForemanSubmitResponse> {
    const fetchImpl = this.params.fetch ?? globalThis.fetch;
    const url = new URL(`/agents/${encodeURIComponent(agentName)}/submit`, worker.baseUrl);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: jsonHeaders(worker.bearerToken),
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        ok: false,
        code: "host_unreachable",
        retryable: true,
        recommendedAction: "retry",
        message: error instanceof Error ? error.message : "Foreman worker is unreachable.",
      };
    }
    const payload = (await response.json().catch(() => null)) as ForemanSubmitResponse | null;
    if (payload && typeof payload === "object" && "ok" in payload) {
      return payload;
    }
    return {
      ok: false,
      code: "worker_protocol_error",
      retryable: false,
      recommendedAction: "ask_owner",
      message: `Foreman worker returned an invalid response: HTTP ${response.status}`,
    };
  }
}

export class ForemanLiveTransportController {
  constructor(
    private readonly params: {
      controller: ForemanTaskFlowController;
      workers: Map<string, ForemanWorkerRegistration>;
      workerClient?: ForemanWorkerHttpClient;
      controllerEventsUrl: string;
      controllerBearerToken?: string;
    },
  ) {}

  async submitAssignment(
    input: ForemanAssignmentInput & {
      idleAfterMs?: number;
      submitAckTimeoutMs?: number;
    },
  ): Promise<ForemanSubmitResult> {
    const worker = this.params.workers.get(input.hostId);
    if (!worker) {
      throw new Error(`Foreman worker is not registered: ${input.hostId}`);
    }
    const existingFlow = this.params.controller.findAssignmentByIdempotency(input);
    const existingResponse = existingFlow ? submitResponseFromExistingFlow(existingFlow) : null;
    if (existingFlow && existingResponse) {
      return { ...existingResponse, flow: existingFlow };
    }
    const flow = existingFlow ?? this.params.controller.createAssignment(input);
    const state = requireForemanState(flow);
    const activeAttempt = state.attempts[state.activeAttemptId];
    if (!activeAttempt) {
      throw new Error("Foreman flow active attempt is missing.");
    }
    const client = this.params.workerClient ?? new ForemanWorkerHttpClient();
    const response = await client.submit(worker, input.agentName, {
      flowId: flow.flowId,
      attemptId: state.activeAttemptId,
      prompt: input.prompt,
      idempotencyKey: activeAttempt.idempotencyKey,
      expectedFlowRevision: flow.revision,
      idleAfterMs: input.idleAfterMs ?? 180_000,
      submitAckTimeoutMs: input.submitAckTimeoutMs ?? 30_000,
      controllerEventsUrl: this.params.controllerEventsUrl,
      controllerBearerToken: this.params.controllerBearerToken,
    });
    if (response.ok && response.flowId !== flow.flowId) {
      const responseFlow = this.params.controller.getAssignment(
        input.ownerSessionKey,
        response.flowId,
      );
      if (responseFlow) {
        return { ...response, flow: responseFlow };
      }
    }
    if (!response.ok && response.code === "host_unreachable") {
      const blocked = this.params.controller.applyWorkerEvent(input.ownerSessionKey, {
        flowId: flow.flowId,
        attemptId: state.activeAttemptId,
        eventId: `${state.activeAttemptId}:agent.host_unreachable:controller:${flow.revision}`,
        eventType: "agent.host_unreachable",
        idempotencyKey: activeAttempt.idempotencyKey,
        hostId: input.hostId,
        agentName: input.agentName,
        workerSeq: 0,
        expectedFlowRevision: flow.revision,
        observedAt: input.now,
        payload: { message: response.message, source: "foreman_live_transport_controller" },
      });
      return { ...response, flow: blocked.flow ?? flow };
    }
    return { ...response, flow };
  }
}

export function createForemanControllerHttpHandler(params: {
  transport: ForemanLiveTransportController;
  controller: ForemanTaskFlowController;
  resolveOwnerSessionKey: (event: ForemanWorkerEvent) => string | undefined;
  recordOwnerSessionKey?: (flowId: string, ownerSessionKey: string) => void;
  workerBearerToken: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://foreman.local");
    if (req.method !== "POST") {
      return false;
    }

    if (url.pathname === "/foreman/flows") {
      const body = await readHttpJson(req);
      if (!isRecord(body)) {
        writeHttpJson(res, 400, { ok: false, error: "invalid_foreman_submit_body" });
        return true;
      }
      let result: ForemanSubmitResult;
      try {
        result = await params.transport.submitAssignment(body as ForemanRouteSubmitBody);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Foreman submit failed.";
        if (!message.startsWith("Foreman worker is not registered:")) {
          throw error;
        }
        writeHttpJson(res, 409, {
          ok: false,
          code: "host_unreachable",
          retryable: false,
          recommendedAction: "ask_owner",
          message,
        });
        return true;
      }
      if (typeof body.ownerSessionKey === "string") {
        params.recordOwnerSessionKey?.(result.flow.flowId, body.ownerSessionKey);
      }
      const json = toJsonResponse(result);
      writeHttpJson(res, json.status, json.body);
      return true;
    }

    if (url.pathname === "/foreman/events") {
      if (req.headers.authorization !== `Bearer ${params.workerBearerToken}`) {
        writeHttpJson(res, 401, { ok: false, reason: "worker_unauthorized" });
        return true;
      }
      const body = await readHttpJson(req);
      if (!isRecord(body)) {
        writeHttpJson(res, 400, { ok: false, error: "invalid_foreman_event_body" });
        return true;
      }
      const event = body as ForemanWorkerEvent;
      const ownerSessionKey = params.resolveOwnerSessionKey(event);
      if (!ownerSessionKey) {
        writeHttpJson(res, 409, { ok: false, reason: "owner_session_not_resolved" });
        return true;
      }
      const result = params.controller.applyWorkerEvent(ownerSessionKey, event);
      writeHttpJson(res, result.applied ? 200 : 409, {
        ok: result.applied,
        reason: result.applied ? undefined : result.reason,
        revision: result.flow?.revision,
      });
      return true;
    }

    return false;
  };
}

export function createForemanWorkerHttpHandler(params: {
  worker: ForemanTmuxWorker;
  bearerToken?: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://foreman-worker.local");
    if (req.method !== "POST") {
      return false;
    }
    const match = /^\/agents\/([^/]+)\/submit$/u.exec(url.pathname);
    if (!match) {
      return false;
    }
    if (params.bearerToken && req.headers.authorization !== `Bearer ${params.bearerToken}`) {
      writeHttpJson(res, 401, { ok: false, code: "worker_unauthorized" });
      return true;
    }
    const body = await readHttpJson(req);
    if (!isRecord(body)) {
      writeHttpJson(res, 400, { ok: false, error: "invalid_foreman_worker_submit_body" });
      return true;
    }
    const result = await params.worker.submit({
      ...(body as ForemanSubmitRequest),
      agentName: decodeURIComponent(match[1] ?? ""),
    });
    const json = toJsonResponse(result);
    writeHttpJson(res, json.status, json.body);
    return true;
  };
}

export type ForemanTmuxExecResult = {
  stdout: string;
  stderr?: string;
};

export type ForemanTmuxRunner = {
  execTmux: (args: string[]) => Promise<ForemanTmuxExecResult>;
};

export type ForemanWorkerSubmitParams = ForemanSubmitRequest & {
  hostId: string;
  agentName: string;
};

export type ForemanWorkerEventSink = {
  send: (event: ForemanWorkerEvent) => Promise<{ revision?: number } | void>;
};

export type ForemanPendingWorkerEventRecord = {
  event: ForemanWorkerEvent;
};

export type ForemanPendingEventStore = {
  list: () => Promise<ForemanPendingWorkerEventRecord[]>;
  upsert: (record: ForemanPendingWorkerEventRecord) => Promise<void>;
  delete: (eventId: string) => Promise<void>;
};

export type ForemanWorkerWatchRecord = {
  flowId: string;
  attemptId: string;
  idempotencyKey: string;
  hostId: string;
  agentName: string;
  prompt: string;
  phase: Extract<ForemanAttemptPhase, "submitted_to_pty" | "running">;
  submittedAt: number;
  startedWorkAt?: number;
  lastActivityAt?: number;
  paneTextBefore: string;
  lastPaneText: string;
  idleAfterMs: number;
  submitAckTimeoutMs: number;
  expectedFlowRevision?: number;
  workerSeq: number;
};

export type ForemanWorkerWatchStore = {
  list: () => Promise<ForemanWorkerWatchRecord[]>;
  upsert: (record: ForemanWorkerWatchRecord) => Promise<void>;
  delete: (attemptId: string) => Promise<void>;
};

export class ForemanMemoryPendingEventStore implements ForemanPendingEventStore {
  private readonly records = new Map<string, ForemanPendingWorkerEventRecord>();

  async list(): Promise<ForemanPendingWorkerEventRecord[]> {
    return [...this.records.values()].sort(
      (left, right) => left.event.workerSeq - right.event.workerSeq,
    );
  }

  async upsert(record: ForemanPendingWorkerEventRecord): Promise<void> {
    this.records.set(record.event.eventId, record);
  }

  async delete(eventId: string): Promise<void> {
    this.records.delete(eventId);
  }
}

export class ForemanMemoryWatchStore implements ForemanWorkerWatchStore {
  private readonly records = new Map<string, ForemanWorkerWatchRecord>();

  async list(): Promise<ForemanWorkerWatchRecord[]> {
    return [...this.records.values()];
  }

  async upsert(record: ForemanWorkerWatchRecord): Promise<void> {
    this.records.set(record.attemptId, record);
  }

  async delete(attemptId: string): Promise<void> {
    this.records.delete(attemptId);
  }
}

export class ForemanFilePendingEventStore implements ForemanPendingEventStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<ForemanPendingWorkerEventRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ForemanPendingWorkerEventRecord[];
      return parsed.sort((left, right) => left.event.workerSeq - right.event.workerSeq);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async upsert(record: ForemanPendingWorkerEventRecord): Promise<void> {
    const records = await this.list();
    const next = [
      ...records.filter((candidate) => candidate.event.eventId !== record.event.eventId),
      record,
    ].sort((left, right) => left.event.workerSeq - right.event.workerSeq);
    await this.write(next);
  }

  async delete(eventId: string): Promise<void> {
    const records = (await this.list()).filter((record) => record.event.eventId !== eventId);
    await this.write(records);
  }

  private async write(records: ForemanPendingWorkerEventRecord[]) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(records), "utf8");
    await rename(tempPath, this.filePath);
  }
}

export class ForemanFileWatchStore implements ForemanWorkerWatchStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<ForemanWorkerWatchRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as ForemanWorkerWatchRecord[];
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async upsert(record: ForemanWorkerWatchRecord): Promise<void> {
    const records = await this.list();
    await this.write([
      ...records.filter((candidate) => candidate.attemptId !== record.attemptId),
      record,
    ]);
  }

  async delete(attemptId: string): Promise<void> {
    await this.write((await this.list()).filter((record) => record.attemptId !== attemptId));
  }

  private async write(records: ForemanWorkerWatchRecord[]) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(records), "utf8");
    await rename(tempPath, this.filePath);
  }
}

export class ForemanHttpEventSink implements ForemanWorkerEventSink {
  constructor(
    private readonly params: {
      fetch?: FetchLike;
      url: string;
      bearerToken?: string;
      maxAttempts?: number;
      retryDelayMs?: number;
    },
  ) {}

  async send(event: ForemanWorkerEvent): Promise<{ revision?: number }> {
    const fetchImpl = this.params.fetch ?? globalThis.fetch;
    const maxAttempts = this.params.maxAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(this.params.url, {
          method: "POST",
          headers: jsonHeaders(this.params.bearerToken),
          body: JSON.stringify(event),
        });
        const payload = (await response.json().catch(() => null)) as { revision?: unknown } | null;
        if (!response.ok) {
          const reason =
            payload && "reason" in payload ? (payload as { reason?: unknown }).reason : undefined;
          if (reason === "duplicate_event") {
            if (typeof payload?.revision === "number") {
              return { revision: payload.revision };
            }
            throw new Error(
              `Foreman controller ${reason} response did not include current revision`,
            );
          }
          throw new Error(`Foreman controller event delivery failed: HTTP ${response.status}`);
        }
        return typeof payload?.revision === "number" ? { revision: payload.revision } : {};
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.params.retryDelayMs ?? 250));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Foreman controller event delivery failed.");
  }
}

class ForemanPendingEventQueue {
  constructor(
    private readonly params: {
      store: ForemanPendingEventStore;
      sink: ForemanWorkerEventSink;
      getExpectedRevision: () => number | undefined;
      setExpectedRevision: (revision: number | undefined) => void;
    },
  ) {}

  async enqueue(event: ForemanWorkerEvent): Promise<void> {
    await this.params.store.upsert({ event });
    await this.flush();
  }

  async flush(): Promise<void> {
    const pending = await this.params.store.list();
    const groups = new Map<string, ForemanPendingWorkerEventRecord[]>();
    for (const record of pending) {
      const key = `${record.event.flowId}:${record.event.hostId}:${record.event.attemptId}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    for (const records of groups.values()) {
      let expectedRevision =
        records[0]?.event.expectedFlowRevision ?? this.params.getExpectedRevision();
      for (const record of records.sort(
        (left, right) => left.event.workerSeq - right.event.workerSeq,
      )) {
        const event = {
          ...record.event,
          expectedFlowRevision: expectedRevision,
        };
        try {
          const result = await this.params.sink.send(event);
          if (result && typeof result.revision === "number") {
            expectedRevision = result.revision;
            this.params.setExpectedRevision(expectedRevision);
          }
          await this.params.store.delete(record.event.eventId);
        } catch {
          break;
        }
      }
    }
  }
}

export class LocalTmuxRunner implements ForemanTmuxRunner {
  async execTmux(args: string[]): Promise<ForemanTmuxExecResult> {
    const { stdout, stderr } = await execFileAsync("tmux", args, { encoding: "utf8" });
    return { stdout, stderr };
  }
}

function trimLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasAgentSignature(paneText: string): boolean {
  return /\b(codex|claude|gemini|opencode)\b/i.test(paneText);
}

function hasPaneChanged(before: string, after: string): boolean {
  return before.trim() !== after.trim() && after.trim().length > 0;
}

function changedPaneText(before: string, after: string): string {
  const trimmedBefore = before.trimEnd();
  const trimmedAfter = after.trimEnd();
  if (trimmedAfter.startsWith(trimmedBefore)) {
    return trimmedAfter.slice(trimmedBefore.length);
  }
  const beforeLines = new Set(trimLines(trimmedBefore));
  return trimLines(trimmedAfter)
    .filter((line) => !beforeLines.has(line))
    .join("\n");
}

type PaneEvidence = {
  detection: string;
  changedTextHash?: string;
  matchedLineHash?: string;
};

function activeWorkIndicatorEvidence(paneText: string): PaneEvidence | null {
  const line = trimLines(paneText)
    .slice(-5)
    .reverse()
    .find((candidate) =>
      /^\s*(?:[•*-]\s*)?(tool call|running (command|tool)|executing|thinking|searching files?)\b/i.test(
        candidate,
      ),
    );
  if (line) {
    return {
      detection: "tmux_pane_active_work_indicator",
      matchedLineHash: proofHash(line),
    };
  }
  return null;
}

function workStartEvidence(
  before: string,
  after: string,
  submittedPrompt: string,
): PaneEvidence | null {
  if (!hasPaneChanged(before, after)) {
    return null;
  }
  const promptLines = new Set(trimLines(submittedPrompt));
  const changedText = changedPaneText(before, after)
    .split(/\r?\n/)
    .filter((line) => !promptLines.has(line.trim()))
    .join("\n");
  const matchedLine = trimLines(changedText).find((line) =>
    /^\s*(?:[•*-]\s*)?(tool call|running (command|tool)|executing|ran|edited|created|updated|wrote|read( file)?|searching files?)\b/i.test(
      line,
    ),
  );
  return matchedLine
    ? {
        detection: "tmux_pane_delta_active_work_evidence",
        changedTextHash: proofHash(changedText),
        matchedLineHash: proofHash(matchedLine),
      }
    : null;
}

function hasCurrentBusyEvidence(paneText: string): boolean {
  return /\b(working|running|thinking|executing)\b/i.test(trimLines(paneText).slice(-5).join("\n"));
}

function proofHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function tmuxBufferName(attemptId: string): string {
  return `foreman_${attemptId.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function tmuxSubmissionMarkerName(attemptId: string): string {
  return `${tmuxBufferName(attemptId)}_submitted`;
}

function submissionMarkerPayload(
  params: ForemanWorkerSubmitParams,
  submittedPayloadHash: string,
  state: "paste_started" | "submitted_to_pty",
) {
  return JSON.stringify({
    flowId: params.flowId,
    attemptId: params.attemptId,
    idempotencyKey: params.idempotencyKey,
    hostId: params.hostId,
    agentName: params.agentName,
    submittedPayloadHash,
    state,
  });
}

function eventBase(
  params: ForemanWorkerSubmitParams,
  seq: number,
  expectedFlowRevision: number | undefined,
): Omit<ForemanWorkerEvent, "eventId" | "eventType"> {
  return {
    flowId: params.flowId,
    attemptId: params.attemptId,
    idempotencyKey: params.idempotencyKey,
    hostId: params.hostId,
    agentName: params.agentName,
    workerSeq: seq,
    expectedFlowRevision,
  };
}

export class ForemanTmuxWorker {
  private readonly pendingEvents: ForemanPendingEventStore;
  private readonly watches: ForemanWorkerWatchStore;
  private readonly activeByAgent = new Map<
    string,
    {
      flowId: string;
      attemptId: string;
      idempotencyKey: string;
      phase: Extract<
        ForemanAttemptPhase,
        "submitted_to_pty" | "accepted" | "running" | "waiting_for_owner_check"
      >;
      submittedAt: number;
      startedWorkAt?: number;
    }
  >();
  private readonly inFlightSubmits = new Map<
    string,
    { idempotencyKey: string; done: Promise<void>; release: () => void }
  >();

  constructor(
    private readonly params: {
      hostId: string;
      tmux: ForemanTmuxRunner;
      pendingEvents?: ForemanPendingEventStore;
      watches?: ForemanWorkerWatchStore;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      pollIntervalMs?: number;
    },
  ) {
    this.pendingEvents = params.pendingEvents ?? new ForemanMemoryPendingEventStore();
    this.watches = params.watches ?? new ForemanMemoryWatchStore();
  }

  async submit(
    params: ForemanSubmitRequest & { agentName: string },
  ): Promise<ForemanSubmitResponse> {
    const submit = { ...params, hostId: this.params.hostId };
    const eventSink = new ForemanHttpEventSink({
      url: params.controllerEventsUrl,
      bearerToken: params.controllerBearerToken,
    });
    return this.submitWithEventSink(submit, eventSink);
  }

  async submitWithEventSink(
    params: ForemanWorkerSubmitParams,
    eventSink: ForemanWorkerEventSink,
  ): Promise<ForemanSubmitResponse> {
    const now = this.params.now ?? Date.now;
    const sleep =
      this.params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollIntervalMs = this.params.pollIntervalMs ?? 250;
    let expectedRevision: number | undefined = params.expectedFlowRevision;
    let workerSeq = 0;
    const eventQueue = new ForemanPendingEventQueue({
      store: this.pendingEvents,
      sink: eventSink,
      getExpectedRevision: () => expectedRevision,
      setExpectedRevision: (revision) => {
        expectedRevision = revision;
      },
    });
    const sendEvent = async (
      eventType: ForemanWorkerEvent["eventType"],
      fields: Partial<ForemanWorkerEvent> = {},
    ) => {
      workerSeq += 1;
      await eventQueue.enqueue({
        ...eventBase(params, workerSeq, expectedRevision),
        eventId: `${params.attemptId}:${eventType}:${workerSeq}`,
        eventType,
        observedAt: now(),
        payload: {},
        ...fields,
      });
    };
    const writeWatch = async (
      phase: Extract<ForemanAttemptPhase, "submitted_to_pty" | "running">,
      values: {
        paneTextBefore: string;
        lastPaneText: string;
        submittedAt: number;
        startedWorkAt?: number;
        lastActivityAt?: number;
      },
    ) => {
      await this.watches.upsert({
        flowId: params.flowId,
        attemptId: params.attemptId,
        idempotencyKey: params.idempotencyKey,
        hostId: params.hostId,
        agentName: params.agentName,
        prompt: params.prompt,
        phase,
        submittedAt: values.submittedAt,
        ...(values.startedWorkAt ? { startedWorkAt: values.startedWorkAt } : {}),
        ...(values.lastActivityAt ? { lastActivityAt: values.lastActivityAt } : {}),
        paneTextBefore: values.paneTextBefore,
        lastPaneText: values.lastPaneText,
        idleAfterMs: params.idleAfterMs,
        submitAckTimeoutMs: params.submitAckTimeoutMs,
        expectedFlowRevision: expectedRevision,
        workerSeq,
      });
    };
    const inFlight = this.inFlightSubmits.get(params.agentName);
    if (inFlight) {
      if (inFlight.idempotencyKey === params.idempotencyKey) {
        await inFlight.done;
        return this.submitWithEventSink(params, eventSink);
      }
      await sendEvent("agent.agent_busy", {
        payload: {
          reason: "in_flight_foreman_submit",
          activeIdempotencyKey: inFlight.idempotencyKey,
        },
      });
      return {
        ok: false,
        code: "agent_busy",
        retryable: false,
        recommendedAction: "steer_or_replace",
        message: `Agent already has an in-flight Foreman submit: ${params.agentName}.`,
      };
    }
    let releaseInFlight = () => {};
    const doneInFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    this.inFlightSubmits.set(params.agentName, {
      idempotencyKey: params.idempotencyKey,
      done: doneInFlight,
      release: releaseInFlight,
    });
    try {
      return await this.submitWithEventSinkLocked({
        params,
        eventSink,
        eventQueue,
        sendEvent,
        writeWatch: async (phase, values) => {
          await writeWatch(phase, values);
        },
        now,
        sleep,
        pollIntervalMs,
        getExpectedRevision: () => expectedRevision,
        getWorkerSeq: () => workerSeq,
      });
    } finally {
      const currentInFlight = this.inFlightSubmits.get(params.agentName);
      if (currentInFlight?.done === doneInFlight) {
        this.inFlightSubmits.delete(params.agentName);
      }
      releaseInFlight();
    }
  }

  private async submitWithEventSinkLocked(locked: {
    params: ForemanWorkerSubmitParams;
    eventSink: ForemanWorkerEventSink;
    eventQueue: ForemanPendingEventQueue;
    sendEvent: (
      eventType: ForemanWorkerEvent["eventType"],
      fields?: Partial<ForemanWorkerEvent>,
    ) => Promise<void>;
    writeWatch: (
      phase: Extract<ForemanAttemptPhase, "submitted_to_pty" | "running">,
      values: {
        paneTextBefore: string;
        lastPaneText: string;
        submittedAt: number;
        startedWorkAt?: number;
        lastActivityAt?: number;
      },
    ) => Promise<void>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs: number;
    getExpectedRevision: () => number | undefined;
    getWorkerSeq: () => number;
  }): Promise<ForemanSubmitResponse> {
    const {
      params: submitParams,
      eventSink,
      eventQueue,
      sendEvent,
      writeWatch,
      now,
      sleep,
      pollIntervalMs,
      getExpectedRevision,
      getWorkerSeq,
    } = locked;
    const params = submitParams;
    await eventQueue.flush();
    const active = this.activeByAgent.get(submitParams.agentName);
    if (active) {
      if (active.idempotencyKey === submitParams.idempotencyKey) {
        return {
          ok: true,
          flowId: active.flowId,
          attemptId: active.attemptId,
          hostId: submitParams.hostId,
          agentName: submitParams.agentName,
          phase: active.phase,
          submittedAt: active.submittedAt,
          ...(active.startedWorkAt ? { startedWorkAt: active.startedWorkAt } : {}),
        };
      }
      await sendEvent("agent.agent_busy", {
        payload: { reason: "active_foreman_attempt", activeAttemptId: active.attemptId },
      });
      return {
        ok: false,
        code: "agent_busy",
        retryable: false,
        recommendedAction: "steer_or_replace",
        message: `Agent is already working on ${active.attemptId}.`,
      };
    }
    const persistedWatch = (await this.watches.list()).find(
      (watch) => watch.agentName === submitParams.agentName,
    );
    if (persistedWatch) {
      if (persistedWatch.idempotencyKey === submitParams.idempotencyKey) {
        void this.resumePendingWatches(eventSink).catch(() => undefined);
        return {
          ok: true,
          flowId: persistedWatch.flowId,
          attemptId: persistedWatch.attemptId,
          hostId: persistedWatch.hostId,
          agentName: submitParams.agentName,
          phase: persistedWatch.phase,
          submittedAt: persistedWatch.submittedAt,
          ...(persistedWatch.startedWorkAt ? { startedWorkAt: persistedWatch.startedWorkAt } : {}),
        };
      }
      await sendEvent("agent.agent_busy", {
        payload: {
          reason: "persisted_foreman_watch",
          activeFlowId: persistedWatch.flowId,
          activeAttemptId: persistedWatch.attemptId,
        },
      });
      return {
        ok: false,
        code: "agent_busy",
        retryable: false,
        recommendedAction: "steer_or_replace",
        message: `Agent is already tracked by Foreman watch ${persistedWatch.attemptId}.`,
      };
    }

    const sessions = trimLines(
      (await this.params.tmux.execTmux(["list-sessions", "-F", "#{session_name}"])).stdout,
    );
    if (!sessions.includes(submitParams.agentName)) {
      await sendEvent("agent.session_not_found");
      return {
        ok: false,
        code: "session_not_found",
        retryable: false,
        recommendedAction: "ask_owner",
        message: `Tmux session not found: ${submitParams.agentName}`,
      };
    }

    const submittedPayload = submitParams.prompt;
    const submittedPayloadHash = proofHash(submittedPayload);
    const bufferName = tmuxBufferName(submitParams.attemptId);
    const markerName = tmuxSubmissionMarkerName(submitParams.attemptId);
    const submittedAt = now();
    const pasteStartedMarkerPayload = submissionMarkerPayload(
      params,
      submittedPayloadHash,
      "paste_started",
    );
    const submittedMarkerPayload = submissionMarkerPayload(
      params,
      submittedPayloadHash,
      "submitted_to_pty",
    );
    const existingMarker = await this.readTmuxBuffer(markerName);
    if (existingMarker === submittedMarkerPayload) {
      const currentPaneText = (
        await this.params.tmux.execTmux(["capture-pane", "-p", "-t", params.agentName])
      ).stdout;
      await writeWatch("submitted_to_pty", {
        paneTextBefore: currentPaneText,
        lastPaneText: currentPaneText,
        submittedAt,
      });
      this.activeByAgent.set(params.agentName, {
        flowId: params.flowId,
        attemptId: params.attemptId,
        idempotencyKey: params.idempotencyKey,
        phase: "submitted_to_pty",
        submittedAt,
      });
      await sendEvent("agent.prompt_submitted_to_pty", {
        observedAt: submittedAt,
        payload: {
          proofKind: "tmux.named_buffer_paste",
          bufferName,
          markerName,
          submittedPayloadHash,
          replayedFromMarker: true,
        },
        paneRef: { tmuxSession: params.agentName },
      });
      const markerReplayEvidence = activeWorkIndicatorEvidence(currentPaneText);
      if (markerReplayEvidence) {
        const startedWorkAt = now();
        const paneRef: ForemanPaneRef = { tmuxSession: params.agentName };
        await sendEvent("agent.started_work", {
          observedAt: startedWorkAt,
          lastActivityAt: startedWorkAt,
          payload: { replayedFromMarker: true, ...markerReplayEvidence },
          paneRef,
        });
        await writeWatch("running", {
          paneTextBefore: currentPaneText,
          lastPaneText: currentPaneText,
          submittedAt,
          startedWorkAt,
          lastActivityAt: startedWorkAt,
        });
        this.activeByAgent.set(params.agentName, {
          flowId: params.flowId,
          attemptId: params.attemptId,
          idempotencyKey: params.idempotencyKey,
          phase: "running",
          submittedAt,
          startedWorkAt,
        });
        void this.watchForIdleAfterWork({
          params,
          sendEvent,
          paneRef,
          sleep,
          pollIntervalMs,
          startedWorkAt,
          paneTextAfter: currentPaneText,
          submittedAt,
          expectedRevision: getExpectedRevision(),
          workerSeq: getWorkerSeq(),
        }).catch(async (error) => {
          await sendEvent("agent.session_not_found", {
            observedAt: now(),
            payload: {
              reason: "idle_watch_failed",
              message: error instanceof Error ? error.message : "tmux idle watch failed",
            },
            paneRef,
          });
          await this.watches.delete(params.attemptId);
          this.activeByAgent.delete(params.agentName);
        });
        return {
          ok: true,
          flowId: params.flowId,
          attemptId: params.attemptId,
          hostId: params.hostId,
          agentName: params.agentName,
          phase: "running",
          submittedAt,
          startedWorkAt,
        };
      }
      return {
        ok: true,
        flowId: params.flowId,
        attemptId: params.attemptId,
        hostId: params.hostId,
        agentName: params.agentName,
        phase: "submitted_to_pty",
        submittedAt,
      };
    }
    if (existingMarker === pasteStartedMarkerPayload) {
      await sendEvent("agent.prompt_submit_failed", {
        observedAt: submittedAt,
        payload: {
          reason: "submission_state_uncertain",
          markerName,
          submittedPayloadHash,
        },
        paneRef: { tmuxSession: params.agentName },
      });
      return {
        ok: false,
        code: "prompt_submit_failed",
        retryable: false,
        recommendedAction: "ask_owner",
        message: `Prompt submission state is uncertain for tmux session: ${params.agentName}`,
      };
    }

    const paneTextBefore = (
      await this.params.tmux.execTmux(["capture-pane", "-p", "-t", params.agentName])
    ).stdout;
    if (!hasAgentSignature(paneTextBefore)) {
      await sendEvent("agent.agent_not_detected");
      return {
        ok: false,
        code: "agent_not_detected",
        retryable: false,
        recommendedAction: "ask_owner",
        message: `No known coding agent signature detected in tmux session: ${params.agentName}`,
      };
    }
    if (hasCurrentBusyEvidence(paneTextBefore)) {
      await sendEvent("agent.agent_busy", {
        payload: { reason: "pre_submit_busy_indicator" },
      });
      return {
        ok: false,
        code: "agent_busy",
        retryable: false,
        recommendedAction: "steer_or_replace",
        message: `Agent is already working in tmux session: ${params.agentName}`,
      };
    }

    this.activeByAgent.set(params.agentName, {
      flowId: params.flowId,
      attemptId: params.attemptId,
      idempotencyKey: params.idempotencyKey,
      phase: "submitted_to_pty",
      submittedAt: now(),
    });

    let pasteAttempted = false;
    try {
      await this.params.tmux.execTmux(["set-buffer", "-b", bufferName, submittedPayload]);
      const bufferedPayload = (await this.params.tmux.execTmux(["show-buffer", "-b", bufferName]))
        .stdout;
      if (proofHash(bufferedPayload) !== submittedPayloadHash) {
        throw new Error("tmux buffer verification failed");
      }
      await this.params.tmux.execTmux(["set-buffer", "-b", markerName, pasteStartedMarkerPayload]);
      pasteAttempted = true;
      await this.params.tmux.execTmux([
        "paste-buffer",
        "-d",
        "-b",
        bufferName,
        "-t",
        params.agentName,
      ]);
      await this.params.tmux.execTmux(["send-keys", "-t", params.agentName, "C-m"]);
      await this.params.tmux.execTmux(["set-buffer", "-b", markerName, submittedMarkerPayload]);
    } catch (error) {
      await sendEvent("agent.prompt_submit_failed", {
        observedAt: now(),
        payload: {
          reason: pasteAttempted ? "submission_state_uncertain" : "tmux_paste_failed",
          message: error instanceof Error ? error.message : "tmux paste failed",
          markerName,
          submittedPayloadHash,
        },
      });
      this.activeByAgent.delete(params.agentName);
      return {
        ok: false,
        code: "prompt_submit_failed",
        retryable: !pasteAttempted,
        recommendedAction: pasteAttempted ? "ask_owner" : "retry",
        message: pasteAttempted
          ? `Prompt submission state is uncertain for tmux session: ${params.agentName}`
          : `Prompt was not pasted into tmux session: ${params.agentName}`,
      };
    }

    await sendEvent("agent.prompt_submitted_to_pty", {
      observedAt: submittedAt,
      payload: {
        proofKind: "tmux.named_buffer_paste",
        bufferName,
        markerName,
        submittedPayloadHash,
      },
      paneRef: { tmuxSession: params.agentName },
    });
    await writeWatch("submitted_to_pty", {
      paneTextBefore,
      lastPaneText: paneTextBefore,
      submittedAt,
    });
    this.activeByAgent.set(params.agentName, {
      flowId: params.flowId,
      attemptId: params.attemptId,
      idempotencyKey: params.idempotencyKey,
      phase: "submitted_to_pty",
      submittedAt,
    });

    const workDeadline = submittedAt + params.submitAckTimeoutMs;
    let paneTextAfter = paneTextBefore;
    let startedEvidence = workStartEvidence(paneTextBefore, paneTextAfter, params.prompt);
    while (!startedEvidence && now() <= workDeadline) {
      await sleep(pollIntervalMs);
      paneTextAfter = (
        await this.params.tmux.execTmux(["capture-pane", "-p", "-t", params.agentName])
      ).stdout;
      startedEvidence = workStartEvidence(paneTextBefore, paneTextAfter, params.prompt);
    }
    if (!startedEvidence) {
      await sendEvent("agent.prompt_not_accepted", {
        payload: {
          reason: "work_start_timeout_after_submitted_to_pty",
          submittedToPty: true,
          submitAckTimeoutMs: params.submitAckTimeoutMs,
          detection: "tmux_pane_delta_without_work_evidence",
        },
      });
      await this.watches.delete(params.attemptId);
      this.activeByAgent.delete(params.agentName);
      return {
        ok: false,
        code: "prompt_not_accepted",
        retryable: true,
        recommendedAction: "retry",
        message:
          "Prompt was submitted to the tmux pane PTY, but no work-start evidence was observed before timeout.",
      };
    }

    const startedWorkAt = now();
    const paneRef: ForemanPaneRef = { tmuxSession: params.agentName };
    await sendEvent("agent.started_work", {
      observedAt: startedWorkAt,
      lastActivityAt: startedWorkAt,
      payload: startedEvidence,
      paneRef,
    });
    await writeWatch("running", {
      paneTextBefore,
      lastPaneText: paneTextAfter,
      submittedAt,
      startedWorkAt,
      lastActivityAt: startedWorkAt,
    });
    this.activeByAgent.set(params.agentName, {
      flowId: params.flowId,
      attemptId: params.attemptId,
      idempotencyKey: params.idempotencyKey,
      phase: "running",
      submittedAt,
      startedWorkAt,
    });

    void this.watchForIdleAfterWork({
      params,
      sendEvent,
      paneRef,
      sleep,
      pollIntervalMs,
      startedWorkAt,
      paneTextAfter,
      submittedAt,
      expectedRevision: getExpectedRevision(),
      workerSeq: getWorkerSeq(),
    }).catch(async (error) => {
      await sendEvent("agent.session_not_found", {
        observedAt: now(),
        payload: {
          reason: "idle_watch_failed",
          message: error instanceof Error ? error.message : "tmux idle watch failed",
        },
        paneRef,
      });
      await this.watches.delete(params.attemptId);
      this.activeByAgent.delete(params.agentName);
    });

    return {
      ok: true,
      flowId: params.flowId,
      attemptId: params.attemptId,
      hostId: params.hostId,
      agentName: params.agentName,
      phase: "running",
      submittedAt,
      startedWorkAt,
    };
  }

  async flushPendingEvents(eventSink: ForemanWorkerEventSink): Promise<void> {
    const pending = await this.pendingEvents.list();
    let expectedRevision: number | undefined = pending[0]?.event.expectedFlowRevision;
    const eventQueue = new ForemanPendingEventQueue({
      store: this.pendingEvents,
      sink: eventSink,
      getExpectedRevision: () => expectedRevision,
      setExpectedRevision: (revision) => {
        expectedRevision = revision;
      },
    });
    await eventQueue.flush();
  }

  async resumePendingWatches(eventSink: ForemanWorkerEventSink): Promise<void> {
    await this.flushPendingEvents(eventSink);
    for (const watch of await this.watches.list()) {
      const eventParams: ForemanWorkerSubmitParams = {
        flowId: watch.flowId,
        attemptId: watch.attemptId,
        hostId: watch.hostId,
        agentName: watch.agentName,
        prompt: watch.prompt,
        idempotencyKey: watch.idempotencyKey,
        expectedFlowRevision: watch.expectedFlowRevision ?? 0,
        idleAfterMs: watch.idleAfterMs,
        submitAckTimeoutMs: watch.submitAckTimeoutMs,
        controllerEventsUrl: "",
      };
      let expectedRevision = watch.expectedFlowRevision;
      let workerSeq = watch.workerSeq;
      const eventQueue = new ForemanPendingEventQueue({
        store: this.pendingEvents,
        sink: eventSink,
        getExpectedRevision: () => expectedRevision,
        setExpectedRevision: (revision) => {
          expectedRevision = revision;
        },
      });
      const sendEvent = async (
        eventType: ForemanWorkerEvent["eventType"],
        fields: Partial<ForemanWorkerEvent> = {},
      ): Promise<{ workerSeq: number; expectedRevision?: number }> => {
        workerSeq += 1;
        await eventQueue.enqueue({
          ...eventBase(eventParams, workerSeq, expectedRevision),
          eventId: `${watch.attemptId}:${eventType}:${workerSeq}`,
          eventType,
          observedAt: this.params.now ? this.params.now() : Date.now(),
          payload: {},
          ...fields,
        });
        await this.watches.upsert({ ...watch, workerSeq, expectedFlowRevision: expectedRevision });
        return { workerSeq, expectedRevision };
      };
      if (watch.phase === "submitted_to_pty") {
        await this.resumeSubmittedWatch(watch, sendEvent);
        continue;
      }
      await this.watchForIdleAfterWork({
        params: eventParams,
        sendEvent: async (eventType, fields) => {
          await sendEvent(eventType, fields);
        },
        paneRef: { tmuxSession: watch.agentName },
        sleep:
          this.params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
        pollIntervalMs: this.params.pollIntervalMs ?? 250,
        startedWorkAt: watch.startedWorkAt ?? watch.submittedAt,
        lastActivityAt: watch.lastActivityAt,
        paneTextAfter: watch.lastPaneText,
        submittedAt: watch.submittedAt,
        expectedRevision,
        workerSeq,
      });
    }
  }

  private async resumeSubmittedWatch(
    watch: ForemanWorkerWatchRecord,
    sendEvent: (
      eventType: ForemanWorkerEvent["eventType"],
      fields?: Partial<ForemanWorkerEvent>,
    ) => Promise<{ workerSeq: number; expectedRevision?: number }>,
  ) {
    const now = this.params.now ?? Date.now;
    const sleep =
      this.params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const pollIntervalMs = this.params.pollIntervalMs ?? 250;
    const workDeadline = watch.submittedAt + watch.submitAckTimeoutMs;
    let paneTextAfter = watch.lastPaneText;
    let startedEvidence = workStartEvidence(watch.paneTextBefore, paneTextAfter, watch.prompt);
    while (!startedEvidence && now() <= workDeadline) {
      await sleep(pollIntervalMs);
      paneTextAfter = (
        await this.params.tmux.execTmux(["capture-pane", "-p", "-t", watch.agentName])
      ).stdout;
      await this.watches.upsert({ ...watch, lastPaneText: paneTextAfter });
      startedEvidence = workStartEvidence(watch.paneTextBefore, paneTextAfter, watch.prompt);
    }
    if (!startedEvidence) {
      await sendEvent("agent.prompt_not_accepted", {
        payload: {
          reason: "work_start_timeout_after_submitted_to_pty",
          submittedToPty: true,
          submitAckTimeoutMs: watch.submitAckTimeoutMs,
          detection: "tmux_pane_delta_without_work_evidence",
        },
      });
      await this.watches.delete(watch.attemptId);
      return;
    }
    const startedWorkAt = now();
    const startedState = await sendEvent("agent.started_work", {
      observedAt: startedWorkAt,
      lastActivityAt: startedWorkAt,
      payload: startedEvidence,
      paneRef: { tmuxSession: watch.agentName },
    });
    await this.watches.upsert({
      ...watch,
      phase: "running",
      startedWorkAt,
      lastActivityAt: startedWorkAt,
      lastPaneText: paneTextAfter,
      workerSeq: startedState.workerSeq,
      expectedFlowRevision: startedState.expectedRevision,
    });
    await this.watchForIdleAfterWork({
      params: {
        flowId: watch.flowId,
        attemptId: watch.attemptId,
        hostId: watch.hostId,
        agentName: watch.agentName,
        prompt: watch.prompt,
        idempotencyKey: watch.idempotencyKey,
        expectedFlowRevision: watch.expectedFlowRevision ?? 0,
        idleAfterMs: watch.idleAfterMs,
        submitAckTimeoutMs: watch.submitAckTimeoutMs,
        controllerEventsUrl: "",
      },
      sendEvent: async (eventType, fields) => {
        await sendEvent(eventType, fields);
      },
      paneRef: { tmuxSession: watch.agentName },
      sleep,
      pollIntervalMs,
      startedWorkAt,
      lastActivityAt: startedWorkAt,
      paneTextAfter,
      submittedAt: watch.submittedAt,
      expectedRevision: startedState.expectedRevision,
      workerSeq: startedState.workerSeq,
    });
  }

  private async readTmuxBuffer(bufferName: string): Promise<string | null> {
    try {
      return (await this.params.tmux.execTmux(["show-buffer", "-b", bufferName])).stdout;
    } catch {
      return null;
    }
  }

  private async watchForIdleAfterWork(params: {
    params: ForemanWorkerSubmitParams;
    sendEvent: (
      eventType: ForemanWorkerEvent["eventType"],
      fields?: Partial<ForemanWorkerEvent>,
    ) => Promise<void>;
    paneRef: ForemanPaneRef;
    sleep: (ms: number) => Promise<void>;
    pollIntervalMs: number;
    startedWorkAt: number;
    lastActivityAt?: number;
    paneTextAfter: string;
    submittedAt: number;
    expectedRevision?: number;
    workerSeq?: number;
  }) {
    let lastText = params.paneTextAfter;
    let lastActivityAt = params.lastActivityAt ?? params.startedWorkAt;
    const now = this.params.now ?? Date.now;
    while (now() - lastActivityAt < params.params.idleAfterMs) {
      await params.sleep(params.pollIntervalMs);
      let currentText: string;
      try {
        currentText = (
          await this.params.tmux.execTmux(["capture-pane", "-p", "-t", params.params.agentName])
        ).stdout;
      } catch (error) {
        await params.sendEvent("agent.session_not_found", {
          observedAt: now(),
          payload: {
            reason: "idle_watch_capture_failed",
            message: error instanceof Error ? error.message : "tmux capture-pane failed",
          },
          paneRef: params.paneRef,
        });
        await this.watches.delete(params.params.attemptId);
        this.activeByAgent.delete(params.params.agentName);
        return;
      }
      const changed = hasPaneChanged(lastText, currentText);
      const activeWork = activeWorkIndicatorEvidence(currentText);
      if (changed) {
        lastText = currentText;
        lastActivityAt = now();
      } else if (activeWork) {
        lastActivityAt = now();
      }
      if (changed || activeWork) {
        await this.watches.upsert({
          flowId: params.params.flowId,
          attemptId: params.params.attemptId,
          idempotencyKey: params.params.idempotencyKey,
          hostId: params.params.hostId,
          agentName: params.params.agentName,
          prompt: params.params.prompt,
          phase: "running",
          submittedAt: params.submittedAt,
          startedWorkAt: params.startedWorkAt,
          lastActivityAt,
          paneTextBefore: params.paneTextAfter,
          lastPaneText: lastText,
          idleAfterMs: params.params.idleAfterMs,
          submitAckTimeoutMs: params.params.submitAckTimeoutMs,
          expectedFlowRevision: params.expectedRevision,
          workerSeq: params.workerSeq ?? 0,
        });
      }
    }
    await params.sendEvent("agent.idle_after_work", {
      observedAt: now(),
      lastActivityAt,
      idleMs: params.params.idleAfterMs,
      payload: { lastActivityAt, idleMs: params.params.idleAfterMs },
      paneRef: params.paneRef,
    });
    await this.watches.delete(params.params.attemptId);
    this.activeByAgent.set(params.params.agentName, {
      flowId: params.params.flowId,
      attemptId: params.params.attemptId,
      idempotencyKey: params.params.idempotencyKey,
      phase: "waiting_for_owner_check",
      submittedAt: params.submittedAt,
      startedWorkAt: params.startedWorkAt,
    });
  }
}

export function toJsonResponse(value: ForemanSubmitResponse | { ok: true; applied: boolean }): {
  status: number;
  body: JsonValue;
} {
  if ("applied" in value) {
    return { status: 200, body: value as unknown as JsonValue };
  }
  if (value.ok) {
    return { status: 200, body: value as unknown as JsonValue };
  }
  const status =
    value.code === "session_not_found" || value.code === "agent_not_detected" ? 404 : 409;
  return { status, body: value as unknown as JsonValue };
}
