export type PromptTurnState =
  | "accepted"
  | "queued"
  | "running"
  | "delivered"
  | "canceled"
  | "failed";

export type PromptTurnTerminalState = Extract<PromptTurnState, "delivered" | "canceled" | "failed">;

export interface PromptTurnAdmissionFacts {
  deviceId: string;
  clientMessageId: string;
  clawlineMessageRowId: string;
  streamKey: string;
  contentHash: string;
  attachmentsHash: string;
  state: PromptTurnState;
  correlationId: string;
}

export interface PromptTurnDurableState {
  deviceId: string;
  clientMessageId: string;
  clawlineMessageRowId: string;
  streamKey: string;
  contentHash: string;
  attachmentsHash: string;
  state: PromptTurnState;
  correlationId?: string;
}

export interface PromptTurnRetryPayload {
  deviceId: string;
  clientMessageId: string;
  contentHash: string;
  attachmentsHash: string;
}

export type PromptTurnDuplicateRetryClassification =
  | "accepted-replay"
  | "queued-replay"
  | "running-replay"
  | "delivered-terminal-replay"
  | "canceled-terminal-replay";

export type PromptTurnDuplicateRetryResult =
  | {
      kind: "replay";
      state: Exclude<PromptTurnState, "failed">;
      classification: PromptTurnDuplicateRetryClassification;
      terminalState?: Extract<PromptTurnTerminalState, "delivered" | "canceled">;
      correlationId: string;
      clawlineMessageRowId: string;
    }
  | {
      kind: "reject";
      reason: "payload-mismatch" | "failed-terminal-retry" | "dedupe-key-mismatch";
    };

export type PromptTurnRecoveryClassification =
  | { kind: "terminal"; state: PromptTurnTerminalState }
  | { kind: "preserve-active"; state: "running"; correlationId: string }
  | { kind: "preserve-queued"; state: "queued"; correlationId: string }
  | {
      kind: "fail-recovery";
      state: "failed";
      errorCode: "clawline.promptTurn.recoveredAfterRestart";
    };

const terminalStates = new Set<PromptTurnState>(["delivered", "canceled", "failed"]);

const validTransitions: Readonly<Record<PromptTurnState, ReadonlySet<PromptTurnState>>> = {
  accepted: new Set(["queued", "running", "failed"]),
  queued: new Set(["running", "canceled", "failed"]),
  running: new Set(["delivered", "queued", "canceled", "failed"]),
  delivered: new Set(["failed"]),
  canceled: new Set(),
  failed: new Set(),
};

export function isPromptTurnTerminalState(
  state: PromptTurnState,
): state is PromptTurnTerminalState {
  return terminalStates.has(state);
}

export function isValidClientMessageId(clientMessageId: string): boolean {
  return clientMessageId.startsWith("c_");
}

export function createPromptTurnAdmissionFacts(params: {
  deviceId: string;
  clientMessageId: string;
  clawlineMessageRowId: string;
  streamKey: string;
  contentHash: string;
  attachmentsHash: string;
}): PromptTurnAdmissionFacts {
  if (!isValidClientMessageId(params.clientMessageId)) {
    throw new Error("Clawline prompt-turn client message IDs must start with c_");
  }

  return {
    ...params,
    state: "accepted",
    correlationId: buildPromptTurnCorrelationId(params),
  };
}

export function reconstructPromptTurnAdmissionFacts(
  state: PromptTurnDurableState,
): PromptTurnAdmissionFacts {
  return {
    ...state,
    correlationId:
      state.correlationId ??
      buildPromptTurnCorrelationId({
        deviceId: state.deviceId,
        clientMessageId: state.clientMessageId,
        clawlineMessageRowId: state.clawlineMessageRowId,
        streamKey: state.streamKey,
      }),
  };
}

export function buildPromptTurnCorrelationId(params: {
  deviceId: string;
  clientMessageId: string;
  clawlineMessageRowId: string;
  streamKey: string;
}): string {
  return [
    "clawline-turn",
    encodeCorrelationPart(params.deviceId),
    encodeCorrelationPart(params.clientMessageId),
    encodeCorrelationPart(params.clawlineMessageRowId),
    encodeCorrelationPart(params.streamKey),
  ].join(":");
}

export function transitionPromptTurnState(
  current: PromptTurnState,
  next: PromptTurnState,
): PromptTurnState {
  if (!validTransitions[current]?.has(next)) {
    throw new Error(`Invalid Clawline prompt-turn transition: ${current} -> ${next}`);
  }
  return next;
}

export function classifyDuplicatePromptTurnRetry(
  existing: PromptTurnAdmissionFacts,
  retry: PromptTurnRetryPayload,
): PromptTurnDuplicateRetryResult {
  if (existing.deviceId !== retry.deviceId || existing.clientMessageId !== retry.clientMessageId) {
    return { kind: "reject", reason: "dedupe-key-mismatch" };
  }

  if (
    existing.contentHash !== retry.contentHash ||
    existing.attachmentsHash !== retry.attachmentsHash
  ) {
    return { kind: "reject", reason: "payload-mismatch" };
  }

  if (existing.state === "failed") {
    return { kind: "reject", reason: "failed-terminal-retry" };
  }

  return {
    kind: "replay",
    state: existing.state,
    ...classifyReplay(existing.state),
    correlationId: existing.correlationId,
    clawlineMessageRowId: existing.clawlineMessageRowId,
  };
}

export function resolveQueuedPromptTurnStart(params: {
  state: PromptTurnState;
  cancelRequested: boolean;
}): { owner: "control"; state: "canceled" } | { owner: "runner"; state: "running" } {
  if (params.state !== "queued") {
    throw new Error(`Queued start check requires queued state, received ${params.state}`);
  }

  if (params.cancelRequested) {
    transitionPromptTurnState("queued", "canceled");
    return { owner: "control", state: "canceled" };
  }

  transitionPromptTurnState("queued", "running");
  return { owner: "runner", state: "running" };
}

export function classifyPromptTurnRecovery(params: {
  state: PromptTurnState;
  correlationId: string;
  hasDurableActiveRun: boolean;
  isQueuedInRuntime: boolean;
}): PromptTurnRecoveryClassification {
  if (isPromptTurnTerminalState(params.state)) {
    return { kind: "terminal", state: params.state };
  }

  if (params.hasDurableActiveRun) {
    return { kind: "preserve-active", state: "running", correlationId: params.correlationId };
  }

  if (params.isQueuedInRuntime) {
    return { kind: "preserve-queued", state: "queued", correlationId: params.correlationId };
  }

  return {
    kind: "fail-recovery",
    state: "failed",
    errorCode: "clawline.promptTurn.recoveredAfterRestart",
  };
}

function encodeCorrelationPart(value: string): string {
  return encodeURIComponent(value);
}

function classifyReplay(state: Exclude<PromptTurnState, "failed">): {
  classification: PromptTurnDuplicateRetryClassification;
  terminalState?: Extract<PromptTurnTerminalState, "delivered" | "canceled">;
} {
  switch (state) {
    case "accepted":
      return { classification: "accepted-replay" };
    case "queued":
      return { classification: "queued-replay" };
    case "running":
      return { classification: "running-replay" };
    case "delivered":
      return { classification: "delivered-terminal-replay", terminalState: "delivered" };
    case "canceled":
      return { classification: "canceled-terminal-replay", terminalState: "canceled" };
  }
  return undefined as never;
}
