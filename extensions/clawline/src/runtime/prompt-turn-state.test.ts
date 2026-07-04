import { describe, expect, it } from "vitest";
import {
  buildPromptTurnCorrelationId,
  classifyDuplicatePromptTurnRetry,
  classifyPromptTurnRecovery,
  createPromptTurnAdmissionFacts,
  reconstructPromptTurnAdmissionFacts,
  resolveQueuedPromptTurnStart,
  transitionPromptTurnState,
  type PromptTurnAdmissionFacts,
  type PromptTurnState,
} from "./prompt-turn-state.js";

function admissionFacts(state: PromptTurnState = "accepted"): PromptTurnAdmissionFacts {
  return {
    deviceId: "device-1",
    clientMessageId: "c_123",
    clawlineMessageRowId: "row-1",
    streamKey: "agent:main:clawline:flynn:main",
    contentHash: "content-hash",
    attachmentsHash: "attachments-hash",
    state,
    correlationId: "clawline-turn:device-1:c_123:row-1:agent%3Amain%3Aclawline%3Aflynn%3Amain",
  };
}

describe("prompt-turn-state", () => {
  it("creates accepted admission facts with stable correlation IDs", () => {
    const facts = createPromptTurnAdmissionFacts({
      deviceId: "device-1",
      clientMessageId: "c_123",
      clawlineMessageRowId: "row-1",
      streamKey: "agent:main:clawline:flynn:main",
      contentHash: "content-hash",
      attachmentsHash: "attachments-hash",
    });

    expect(facts).toEqual(admissionFacts("accepted"));
    expect(
      buildPromptTurnCorrelationId({
        deviceId: facts.deviceId,
        clientMessageId: facts.clientMessageId,
        clawlineMessageRowId: facts.clawlineMessageRowId,
        streamKey: facts.streamKey,
      }),
    ).toBe(facts.correlationId);
  });

  it("reconstructs durable prompt-turn facts for every persisted state", () => {
    for (const state of [
      "accepted",
      "queued",
      "running",
      "delivered",
      "failed",
      "canceled",
    ] as const) {
      expect(
        reconstructPromptTurnAdmissionFacts({
          deviceId: "device-1",
          clientMessageId: "c_123",
          clawlineMessageRowId: "row-1",
          streamKey: "agent:main:clawline:flynn:main",
          contentHash: "content-hash",
          attachmentsHash: "attachments-hash",
          state,
        }),
      ).toEqual(admissionFacts(state));
    }
  });

  it("preserves persisted correlation IDs when reconstructing durable prompt-turn facts", () => {
    expect(
      reconstructPromptTurnAdmissionFacts({
        ...admissionFacts("queued"),
        correlationId: "persisted-correlation-id",
      }).correlationId,
    ).toBe("persisted-correlation-id");
  });

  it("rejects non-Clawline client message IDs during admission", () => {
    expect(() =>
      createPromptTurnAdmissionFacts({
        deviceId: "device-1",
        clientMessageId: "m_123",
        clawlineMessageRowId: "row-1",
        streamKey: "agent:main:main",
        contentHash: "content-hash",
        attachmentsHash: "attachments-hash",
      }),
    ).toThrow(/must start with c_/);
  });

  it("allows the Phase 1 prompt-turn state transitions", () => {
    expect(transitionPromptTurnState("accepted", "queued")).toBe("queued");
    expect(transitionPromptTurnState("accepted", "running")).toBe("running");
    expect(transitionPromptTurnState("accepted", "failed")).toBe("failed");
    expect(transitionPromptTurnState("queued", "running")).toBe("running");
    expect(transitionPromptTurnState("queued", "canceled")).toBe("canceled");
    expect(transitionPromptTurnState("queued", "failed")).toBe("failed");
    expect(transitionPromptTurnState("running", "delivered")).toBe("delivered");
    expect(transitionPromptTurnState("running", "queued")).toBe("queued");
    expect(transitionPromptTurnState("running", "canceled")).toBe("canceled");
    expect(transitionPromptTurnState("running", "failed")).toBe("failed");
    expect(transitionPromptTurnState("delivered", "failed")).toBe("failed");
  });

  it("rejects terminal-to-running and backward duplicate-style transitions", () => {
    expect(() => transitionPromptTurnState("failed", "running")).toThrow(/Invalid/);
    expect(() => transitionPromptTurnState("canceled", "running")).toThrow(/Invalid/);
    expect(() => transitionPromptTurnState("delivered", "running")).toThrow(/Invalid/);
    expect(() => transitionPromptTurnState("running", "accepted")).toThrow(/Invalid/);
    expect(() => transitionPromptTurnState("queued", "accepted")).toThrow(/Invalid/);
  });

  it("replays matching duplicate retries while accepted queued running delivered or canceled", () => {
    for (const state of ["accepted", "queued", "running", "delivered", "canceled"] as const) {
      expect(
        classifyDuplicatePromptTurnRetry(admissionFacts(state), {
          deviceId: "device-1",
          clientMessageId: "c_123",
          contentHash: "content-hash",
          attachmentsHash: "attachments-hash",
        }),
      ).toEqual({
        kind: "replay",
        state,
        classification:
          state === "delivered"
            ? "delivered-terminal-replay"
            : state === "canceled"
              ? "canceled-terminal-replay"
              : `${state}-replay`,
        terminalState: state === "delivered" || state === "canceled" ? state : undefined,
        correlationId: admissionFacts(state).correlationId,
        clawlineMessageRowId: "row-1",
      });
    }
  });

  it("rejects duplicate retries with mismatched payload or failed terminal state", () => {
    expect(
      classifyDuplicatePromptTurnRetry(admissionFacts("accepted"), {
        deviceId: "device-1",
        clientMessageId: "c_123",
        contentHash: "changed",
        attachmentsHash: "attachments-hash",
      }),
    ).toEqual({ kind: "reject", reason: "payload-mismatch" });

    expect(
      classifyDuplicatePromptTurnRetry(admissionFacts("accepted"), {
        deviceId: "other-device",
        clientMessageId: "c_123",
        contentHash: "content-hash",
        attachmentsHash: "attachments-hash",
      }),
    ).toEqual({ kind: "reject", reason: "dedupe-key-mismatch" });

    expect(
      classifyDuplicatePromptTurnRetry(admissionFacts("failed"), {
        deviceId: "device-1",
        clientMessageId: "c_123",
        contentHash: "content-hash",
        attachmentsHash: "attachments-hash",
      }),
    ).toEqual({ kind: "reject", reason: "failed-terminal-retry" });
  });

  it("exposes the durable state needed by clients replaying duplicate retries", () => {
    const existing = admissionFacts("running");

    expect(
      classifyDuplicatePromptTurnRetry(existing, {
        deviceId: existing.deviceId,
        clientMessageId: existing.clientMessageId,
        contentHash: existing.contentHash,
        attachmentsHash: existing.attachmentsHash,
      }),
    ).toEqual({
      kind: "replay",
      state: "running",
      classification: "running-replay",
      correlationId: existing.correlationId,
      clawlineMessageRowId: existing.clawlineMessageRowId,
    });
  });

  it("distinguishes delivered and canceled duplicate terminal retries", () => {
    expect(
      classifyDuplicatePromptTurnRetry(admissionFacts("delivered"), {
        deviceId: "device-1",
        clientMessageId: "c_123",
        contentHash: "content-hash",
        attachmentsHash: "attachments-hash",
      }),
    ).toMatchObject({
      kind: "replay",
      state: "delivered",
      classification: "delivered-terminal-replay",
      terminalState: "delivered",
    });

    expect(
      classifyDuplicatePromptTurnRetry(admissionFacts("canceled"), {
        deviceId: "device-1",
        clientMessageId: "c_123",
        contentHash: "content-hash",
        attachmentsHash: "attachments-hash",
      }),
    ).toMatchObject({
      kind: "replay",
      state: "canceled",
      classification: "canceled-terminal-replay",
      terminalState: "canceled",
    });
  });

  it("assigns exactly one owner when cancel races queued start", () => {
    expect(resolveQueuedPromptTurnStart({ state: "queued", cancelRequested: true })).toEqual({
      owner: "control",
      state: "canceled",
    });
    expect(resolveQueuedPromptTurnStart({ state: "queued", cancelRequested: false })).toEqual({
      owner: "runner",
      state: "running",
    });
  });

  it("requires queued state for the queued-start cancellation check", () => {
    expect(() =>
      resolveQueuedPromptTurnStart({ state: "accepted", cancelRequested: true }),
    ).toThrow(/requires queued state/);
  });

  it("classifies restart recovery without mutating transcripts or inventing replies", () => {
    expect(
      classifyPromptTurnRecovery({
        state: "accepted",
        correlationId: "turn-1",
        hasDurableActiveRun: false,
        isQueuedInRuntime: false,
      }),
    ).toEqual({
      kind: "fail-recovery",
      state: "failed",
      errorCode: "clawline.promptTurn.recoveredAfterRestart",
    });

    expect(
      classifyPromptTurnRecovery({
        state: "running",
        correlationId: "turn-1",
        hasDurableActiveRun: true,
        isQueuedInRuntime: false,
      }),
    ).toEqual({ kind: "preserve-active", state: "running", correlationId: "turn-1" });

    expect(
      classifyPromptTurnRecovery({
        state: "queued",
        correlationId: "turn-1",
        hasDurableActiveRun: false,
        isQueuedInRuntime: true,
      }),
    ).toEqual({ kind: "preserve-queued", state: "queued", correlationId: "turn-1" });

    expect(
      classifyPromptTurnRecovery({
        state: "delivered",
        correlationId: "turn-1",
        hasDurableActiveRun: false,
        isQueuedInRuntime: false,
      }),
    ).toEqual({ kind: "terminal", state: "delivered" });
  });
});
