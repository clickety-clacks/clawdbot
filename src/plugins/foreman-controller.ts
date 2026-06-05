import type { JsonValue } from "../tasks/task-flow-registry.types.js";
import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowRecord,
} from "./runtime/runtime-taskflow.types.js";

export type ForemanAttemptPhase =
  | "queued"
  | "submitting"
  | "submitted_to_pty"
  | "accepted"
  | "running"
  | "waiting_for_owner_check"
  | "blocked"
  | "replaced"
  | "cancelled";

export type ForemanPaneRef = {
  tmuxSession: string;
  tmuxWindow?: string;
  tmuxPane?: string;
};

export type ForemanAssignmentInput = {
  ownerSessionKey: string;
  requesterOrigin?: ManagedTaskFlowRecord["requesterOrigin"];
  goal: string;
  hostId: string;
  agentName: string;
  prompt: string;
  attemptId?: string;
  idempotencyKey?: string;
  paneRef?: ForemanPaneRef;
  now?: number;
};

export type ForemanWorkerEventType =
  | "agent.prompt_submitted_to_pty"
  | "agent.prompt_accepted"
  | "agent.started_work"
  | "agent.idle_after_work"
  | "agent.host_unreachable"
  | "agent.session_not_found"
  | "agent.agent_not_detected"
  | "agent.agent_busy"
  | "agent.prompt_submit_failed"
  | "agent.prompt_not_accepted";

export type ForemanWorkerEvent = {
  flowId: string;
  attemptId: string;
  eventId: string;
  eventType: ForemanWorkerEventType;
  idempotencyKey?: string;
  hostId: string;
  agentName: string;
  workerSeq: number;
  expectedFlowRevision?: number;
  observedAt?: number;
  occurredAt?: number;
  idleMs?: number;
  lastActivityAt?: number;
  paneRef?: ForemanPaneRef;
  payload?: JsonValue;
  summary?: string;
};

type ForemanAttemptState = {
  attemptId: string;
  phase: ForemanAttemptPhase;
  hostId: string;
  agentName: string;
  paneRef?: ForemanPaneRef;
  idempotencyKey: string;
  promptHash: string;
  createdAt: number;
  submittedAt?: number;
  acceptedAt?: number;
  startedWorkAt?: number;
  idleAfterWorkAt?: number;
  lastMeaningfulActivityAt?: number;
  lastWorkerSeq?: number;
  lastEventId?: string;
  lastEventType?: ForemanWorkerEventType;
  blockedReason?: string | null;
};

type ForemanFlowState = {
  foremanVersion: 1;
  ownerSessionKey: string;
  goal: string;
  activeAttemptId: string;
  attempts: Record<string, ForemanAttemptState>;
  workers: Record<
    string,
    {
      lastCommandAt?: number;
      lastEventAt?: number;
      lastKnownReachability?: string;
      lastError?: string | null;
    }
  >;
  eventDedupe: { seenEventIds: string[]; lastSeqByAttempt: Record<string, number> };
};

export type ForemanEventResult =
  | { applied: true; flow: ManagedTaskFlowRecord; ignored?: false }
  | {
      applied: false;
      reason:
        | "flow_not_found"
        | "not_managed"
        | "attempt_not_found"
        | "attempt_mismatch"
        | "duplicate_event"
        | "stale_event"
        | "out_of_order_event"
        | "invalid_phase_transition"
        | "revision_conflict";
      flow?: ManagedTaskFlowRecord;
    };

const CONTROLLER_ID = "foreman/controller";
const MAX_SEEN_EVENT_IDS = 100;

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function assignmentIdempotencyKey(input: ForemanAssignmentInput): string {
  return (
    input.idempotencyKey ??
    stableHash(
      `${input.ownerSessionKey}:${input.goal}:${input.hostId}:${input.agentName}:${input.prompt}`,
    )
  );
}

function asForemanState(value: JsonValue | null | undefined): ForemanFlowState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ForemanFlowState>;
  if (candidate.foremanVersion !== 1 || typeof candidate.activeAttemptId !== "string") {
    return null;
  }
  return candidate as ForemanFlowState;
}

function toJson(value: unknown): JsonValue {
  return value as JsonValue;
}

type ForemanEventRejectReason = Exclude<ForemanEventResult, { applied: true }>["reason"];

function getEventPayloadObject(event: ForemanWorkerEvent): Record<string, JsonValue> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function getPayloadNumber(event: ForemanWorkerEvent, key: string): number | undefined {
  const value = getEventPayloadObject(event)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isControllerTransportEvent(event: ForemanWorkerEvent): boolean {
  return (
    event.eventType === "agent.host_unreachable" &&
    getEventPayloadObject(event).source === "foreman_live_transport_controller"
  );
}

function canApplyEventFromPhase(
  eventType: ForemanWorkerEventType,
  attempt: ForemanAttemptState,
): boolean {
  const phase = attempt.phase;
  if (eventType === "agent.prompt_submitted_to_pty") {
    return (
      phase === "queued" ||
      phase === "submitting" ||
      phase === "submitted_to_pty" ||
      (phase === "blocked" && attempt.blockedReason === "agent.host_unreachable")
    );
  }
  if (eventType === "agent.prompt_accepted") {
    return phase === "submitted_to_pty" || phase === "accepted";
  }
  if (eventType === "agent.started_work") {
    return phase === "submitted_to_pty" || phase === "accepted" || phase === "running";
  }
  if (eventType === "agent.idle_after_work") {
    return phase === "running" || phase === "waiting_for_owner_check";
  }
  return phase === "queued" || phase === "submitting" || phase === "submitted_to_pty";
}

function nextStateWithEvent(
  state: ForemanFlowState,
  event: ForemanWorkerEvent,
  now: number,
): { state?: ForemanFlowState; reason?: ForemanEventRejectReason } {
  if (state.eventDedupe.seenEventIds.includes(event.eventId)) {
    return { reason: "duplicate_event" };
  }
  const attempt = state.attempts[event.attemptId];
  if (!attempt) {
    return { reason: "attempt_not_found" };
  }
  if (state.activeAttemptId !== event.attemptId) {
    return { reason: "attempt_mismatch" };
  }
  if (event.idempotencyKey !== undefined && event.idempotencyKey !== attempt.idempotencyKey) {
    return { reason: "attempt_mismatch" };
  }
  const seqKey = `${event.hostId}:${event.attemptId}`;
  const lastSeq = state.eventDedupe.lastSeqByAttempt[seqKey] ?? 0;
  const sequenceTracked = !isControllerTransportEvent(event);
  if (sequenceTracked) {
    if (event.workerSeq <= lastSeq) {
      return { reason: "stale_event" };
    }
    if (event.workerSeq !== lastSeq + 1) {
      return { reason: "out_of_order_event" };
    }
  }
  if (!canApplyEventFromPhase(event.eventType, attempt)) {
    return { reason: "invalid_phase_transition" };
  }

  const eventAt = event.observedAt ?? event.occurredAt ?? now;
  let phase: ForemanAttemptPhase = attempt.phase;
  let blockedReason = attempt.blockedReason ?? null;
  if (event.eventType === "agent.prompt_submitted_to_pty") {
    phase = "submitted_to_pty";
    blockedReason = null;
  }
  if (event.eventType === "agent.prompt_accepted") {
    phase = "accepted";
    blockedReason = null;
  }
  if (event.eventType === "agent.started_work") {
    phase = "running";
    blockedReason = null;
  }
  if (event.eventType === "agent.idle_after_work") {
    phase = "waiting_for_owner_check";
    blockedReason = null;
  }
  if (
    event.eventType === "agent.session_not_found" ||
    event.eventType === "agent.host_unreachable" ||
    event.eventType === "agent.agent_not_detected" ||
    event.eventType === "agent.agent_busy" ||
    event.eventType === "agent.prompt_submit_failed" ||
    event.eventType === "agent.prompt_not_accepted"
  ) {
    phase = "blocked";
    blockedReason = event.eventType;
  }

  const seenEventIds = [...state.eventDedupe.seenEventIds, event.eventId].slice(
    -MAX_SEEN_EVENT_IDS,
  );
  const workerReachability =
    event.eventType === "agent.host_unreachable" ? "unreachable" : "reachable";
  return {
    state: {
      ...state,
      activeAttemptId: event.attemptId,
      attempts: {
        ...state.attempts,
        [event.attemptId]: {
          ...attempt,
          phase,
          paneRef: event.paneRef ?? attempt.paneRef,
          submittedAt:
            event.eventType === "agent.prompt_submitted_to_pty" ? eventAt : attempt.submittedAt,
          acceptedAt: event.eventType === "agent.prompt_accepted" ? eventAt : attempt.acceptedAt,
          startedWorkAt: event.eventType === "agent.started_work" ? eventAt : attempt.startedWorkAt,
          idleAfterWorkAt:
            event.eventType === "agent.idle_after_work" ? eventAt : attempt.idleAfterWorkAt,
          lastMeaningfulActivityAt:
            event.lastActivityAt ??
            getPayloadNumber(event, "lastActivityAt") ??
            attempt.lastMeaningfulActivityAt,
          lastWorkerSeq: event.workerSeq,
          lastEventId: event.eventId,
          lastEventType: event.eventType,
          blockedReason,
        },
      },
      workers: {
        ...state.workers,
        [event.hostId]: {
          ...state.workers[event.hostId],
          lastEventAt: eventAt,
          lastKnownReachability: workerReachability,
          lastError: blockedReason,
        },
      },
      eventDedupe: {
        seenEventIds,
        lastSeqByAttempt: sequenceTracked
          ? { ...state.eventDedupe.lastSeqByAttempt, [seqKey]: event.workerSeq }
          : state.eventDedupe.lastSeqByAttempt,
      },
    },
  };
}

export class ForemanTaskFlowController {
  constructor(
    private readonly taskFlows: {
      bindSession: (params: {
        sessionKey: string;
        requesterOrigin?: ManagedTaskFlowRecord["requesterOrigin"];
      }) => BoundTaskFlowRuntime;
    },
  ) {}

  createAssignment(input: ForemanAssignmentInput): ManagedTaskFlowRecord {
    const now = input.now ?? Date.now();
    const attemptId = input.attemptId ?? `attempt_${now}`;
    const idempotencyKey = assignmentIdempotencyKey(input);
    const runtime = this.taskFlows.bindSession({
      sessionKey: input.ownerSessionKey,
      requesterOrigin: input.requesterOrigin,
    });
    return runtime.createManaged({
      controllerId: CONTROLLER_ID,
      goal: input.goal,
      status: "running",
      currentStep: "foreman.tmux_submit",
      stateJson: toJson({
        foremanVersion: 1,
        ownerSessionKey: input.ownerSessionKey,
        goal: input.goal,
        activeAttemptId: attemptId,
        attempts: {
          [attemptId]: {
            attemptId,
            phase: "queued",
            hostId: input.hostId,
            agentName: input.agentName,
            paneRef: input.paneRef,
            idempotencyKey,
            promptHash: stableHash(input.prompt),
            createdAt: now,
          },
        },
        workers: {
          [input.hostId]: {
            lastCommandAt: now,
            lastKnownReachability: "reachable",
            lastError: null,
          },
        },
        eventDedupe: { seenEventIds: [], lastSeqByAttempt: {} },
      }),
    });
  }

  findAssignmentByIdempotency(input: ForemanAssignmentInput): ManagedTaskFlowRecord | undefined {
    const idempotencyKey = assignmentIdempotencyKey(input);
    const runtime = this.taskFlows.bindSession({
      sessionKey: input.ownerSessionKey,
      requesterOrigin: input.requesterOrigin,
    });
    return runtime.list().find((flow): flow is ManagedTaskFlowRecord => {
      if (flow.syncMode !== "managed" || flow.controllerId !== CONTROLLER_ID) {
        return false;
      }
      const state = asForemanState(flow.stateJson);
      const attempt = state ? state.attempts[state.activeAttemptId] : undefined;
      if (
        state?.ownerSessionKey !== input.ownerSessionKey ||
        attempt?.idempotencyKey !== idempotencyKey
      ) {
        return false;
      }
      return input.idempotencyKey
        ? true
        : state.goal === input.goal &&
            attempt.hostId === input.hostId &&
            attempt.agentName === input.agentName;
    });
  }

  getAssignment(ownerSessionKey: string, flowId: string): ManagedTaskFlowRecord | undefined {
    const runtime = this.taskFlows.bindSession({ sessionKey: ownerSessionKey });
    const flow = runtime.get(flowId);
    return flow?.syncMode === "managed" && flow.controllerId === CONTROLLER_ID
      ? (flow as ManagedTaskFlowRecord)
      : undefined;
  }

  applyWorkerEvent(
    ownerSessionKey: string,
    event: ForemanWorkerEvent,
    now = Date.now(),
  ): ForemanEventResult {
    const runtime = this.taskFlows.bindSession({ sessionKey: ownerSessionKey });
    const flow = runtime.get(event.flowId);
    if (!flow) {
      return { applied: false, reason: "flow_not_found" };
    }
    if (flow.syncMode !== "managed") {
      return { applied: false, reason: "not_managed" };
    }
    const state = asForemanState(flow.stateJson);
    if (!state) {
      return { applied: false, reason: "attempt_not_found", flow: flow as ManagedTaskFlowRecord };
    }
    if (state.eventDedupe.seenEventIds.includes(event.eventId)) {
      return { applied: false, reason: "duplicate_event", flow: flow as ManagedTaskFlowRecord };
    }
    if (event.expectedFlowRevision !== undefined && event.expectedFlowRevision !== flow.revision) {
      return { applied: false, reason: "revision_conflict", flow: flow as ManagedTaskFlowRecord };
    }
    const next = nextStateWithEvent(state, event, now);
    if (!next.state) {
      return {
        applied: false,
        reason: next.reason ?? "attempt_not_found",
        flow: flow as ManagedTaskFlowRecord,
      };
    }

    if (event.eventType === "agent.idle_after_work") {
      const waiting = runtime.setWaiting({
        flowId: event.flowId,
        expectedRevision: flow.revision,
        currentStep: "foreman.owner_check",
        stateJson: toJson(next.state),
        waitJson: toJson({
          kind: "foreman.owner_check",
          reason: "idle_after_work",
          flowId: event.flowId,
          attemptId: event.attemptId,
          hostId: event.hostId,
          agentName: event.agentName,
          ...((event.paneRef ?? next.state.attempts[event.attemptId]?.paneRef)
            ? { paneRef: event.paneRef ?? next.state.attempts[event.attemptId]?.paneRef }
            : {}),
          lastActivityAt: event.lastActivityAt ?? getPayloadNumber(event, "lastActivityAt") ?? now,
          idleMs: event.idleMs ?? getPayloadNumber(event, "idleMs") ?? 0,
          lastWorkerEventId: event.eventId,
          lastWorkerSeq: event.workerSeq,
          allowedActions: [
            "inspect",
            "ask_agent",
            "steer",
            "replace",
            "cancel",
            "mark_blocked",
            "mark_complete",
          ],
          summary:
            event.summary ?? "Agent worked and is now idle; owner must inspect before completion.",
        }),
        updatedAt: now,
      });
      if (!waiting.applied) {
        return {
          applied: false,
          reason: waiting.code === "revision_conflict" ? "revision_conflict" : "flow_not_found",
          flow: flow as ManagedTaskFlowRecord,
        };
      }
      return { applied: true, flow: waiting.flow };
    }

    const resumed = runtime.resume({
      flowId: event.flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep:
        next.state.attempts[event.attemptId]?.phase === "blocked"
          ? "foreman.blocked"
          : "foreman.tmux_submit",
      stateJson: toJson(next.state),
      updatedAt: now,
    });
    if (!resumed.applied) {
      return {
        applied: false,
        reason: resumed.code === "revision_conflict" ? "revision_conflict" : "flow_not_found",
        flow: flow as ManagedTaskFlowRecord,
      };
    }
    return { applied: true, flow: resumed.flow };
  }

  summarize(
    ownerSessionKey: string,
    flowId: string,
  ):
    | {
        flowId: string;
        status: ManagedTaskFlowRecord["status"];
        currentStep: string | null;
        waitJson: JsonValue | null;
        activeAttempt?: ForemanAttemptState;
      }
    | undefined {
    const runtime = this.taskFlows.bindSession({ sessionKey: ownerSessionKey });
    const flow = runtime.get(flowId);
    if (!flow || flow.syncMode !== "managed") {
      return undefined;
    }
    const state = asForemanState(flow.stateJson);
    return {
      flowId: flow.flowId,
      status: flow.status,
      currentStep: flow.currentStep ?? null,
      waitJson: flow.waitJson ?? null,
      activeAttempt: state ? state.attempts[state.activeAttemptId] : undefined,
    };
  }
}
