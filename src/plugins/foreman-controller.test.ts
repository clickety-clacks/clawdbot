import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskStatus } from "../tasks/task-registry.types.js";
import { ForemanTaskFlowController } from "./foreman-controller.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime/runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime/runtime-taskflow.js";

const ownerSessionKey = "agent:main:clawline:flynn:s_foreman";

function createController() {
  return new ForemanTaskFlowController(createRuntimeTaskFlow());
}

describe("Foreman plugin-managed TaskFlow controller", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  afterEach(() => {
    resetRuntimeTaskTestState({ persist: false });
  });

  it("records fake worker idle_after_work in managed flow stateJson and waits for owner inspection", () => {
    const controller = createController();
    const flow = controller.createAssignment({
      ownerSessionKey,
      goal: "prove Foreman handoff",
      hostId: "worker-a",
      agentName: "ticket-agent",
      prompt: "do the work",
      attemptId: "attempt-1",
      now: 1000,
    });

    const accepted = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-1",
      eventType: "agent.prompt_accepted",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 1,
      occurredAt: 1100,
    });
    expect(accepted).toMatchObject({ applied: true });

    const running = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-2",
      eventType: "agent.started_work",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 2,
      occurredAt: 1200,
    });
    expect(running).toMatchObject({ applied: true });

    const idle = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-3",
      eventType: "agent.idle_after_work",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 3,
      occurredAt: 2000,
      lastActivityAt: 1800,
      idleMs: 200,
      paneRef: { tmuxSession: "ticket-agent", tmuxWindow: "0", tmuxPane: "%12" },
    });

    expect(idle).toMatchObject({
      applied: true,
      flow: {
        status: "waiting",
        currentStep: "foreman.owner_check",
        waitJson: {
          kind: "foreman.owner_check",
          reason: "idle_after_work",
          attemptId: "attempt-1",
          hostId: "worker-a",
          agentName: "ticket-agent",
          lastWorkerEventId: "evt-3",
          lastWorkerSeq: 3,
        },
      },
    });
    if (!idle.applied) {
      throw new Error("idle event was not applied");
    }
    expect(idle.flow.stateJson).toMatchObject({
      activeAttemptId: "attempt-1",
      attempts: {
        "attempt-1": {
          phase: "waiting_for_owner_check",
          lastWorkerSeq: 3,
          lastEventType: "agent.idle_after_work",
        },
      },
      eventDedupe: {
        seenEventIds: ["evt-1", "evt-2", "evt-3"],
        lastSeqByAttempt: { "worker-a:attempt-1": 3 },
      },
    });
  });

  it("keeps duplicate, stale, and out-of-order worker event handling in plugin flow state", () => {
    const controller = createController();
    const flow = controller.createAssignment({
      ownerSessionKey,
      goal: "dedupe worker events",
      hostId: "worker-a",
      agentName: "ticket-agent",
      prompt: "do the work",
      attemptId: "attempt-1",
      now: 1000,
    });

    const first = {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-1",
      eventType: "agent.prompt_accepted" as const,
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 1,
      occurredAt: 1100,
    };
    expect(controller.applyWorkerEvent(ownerSessionKey, first)).toMatchObject({ applied: true });
    expect(controller.applyWorkerEvent(ownerSessionKey, first)).toMatchObject({
      applied: false,
      reason: "duplicate_event",
    });
    expect(
      controller.applyWorkerEvent(ownerSessionKey, {
        ...first,
        eventId: "evt-stale",
        workerSeq: 1,
      }),
    ).toMatchObject({ applied: false, reason: "stale_event" });
    expect(
      controller.applyWorkerEvent(ownerSessionKey, {
        ...first,
        eventId: "evt-gap",
        eventType: "agent.started_work",
        workerSeq: 3,
      }),
    ).toMatchObject({ applied: false, reason: "out_of_order_event" });

    const summary = controller.summarize(ownerSessionKey, flow.flowId);
    expect(summary?.activeAttempt).toMatchObject({
      phase: "accepted",
      lastWorkerSeq: 1,
      lastEventId: "evt-1",
    });
  });

  it("does not introduce Foreman-specific core task statuses", () => {
    const coreStatuses: TaskStatus[] = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "lost",
    ];
    expect(coreStatuses).not.toContain("submitted_unacked" as TaskStatus);
    expect(coreStatuses).not.toContain("owner_check_required" as TaskStatus);
  });
});
