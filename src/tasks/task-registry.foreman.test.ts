import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  createTaskRecord,
  getTaskById,
  recordExternalTaskEvent,
  resetTaskRegistryForTests,
  type ForemanExternalTaskEvent,
} from "./task-registry.js";

async function withTaskStores<T>(run: () => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-foreman-task-events-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      return await run();
    } finally {
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

function makeEvent(base: Partial<ForemanExternalTaskEvent> = {}): ForemanExternalTaskEvent {
  return {
    eventId: "evt_1",
    eventType: "agent.prompt_submitted",
    flowId: "flow_missing",
    taskId: "task_missing",
    attemptId: "attempt_1",
    idempotencyKey: "idem_1",
    hostId: "worker-a",
    agentName: "project-ticket-agent",
    workerSeq: 1,
    observedAt: 1_778_090_000_000,
    payload: {},
    ...base,
  };
}

describe("recordExternalTaskEvent", () => {
  afterEach(() => {
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("advances the first-slice Foreman lifecycle without treating idle as done", async () => {
    await withTaskStores(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:clawline:flynn:s_4a2b448d",
        controllerId: "foreman/controller",
        goal: "Run external tmux assignment",
        stateJson: {
          foreman: {
            activeAttempt: { attemptId: "attempt_1", idempotencyKey: "idem_1" },
          },
        },
      });
      const task = createTaskRecord({
        runtime: "external-tmux",
        taskKind: "foreman.tmux_submit",
        requesterSessionKey: flow.ownerKey,
        ownerKey: flow.ownerKey,
        parentFlowId: flow.flowId,
        label: "project-ticket-agent",
        task: "Submit prompt to tmux agent",
        status: "submitting",
        notifyPolicy: "state_changes",
      });

      const submitted = recordExternalTaskEvent(
        makeEvent({
          flowId: flow.flowId,
          taskId: task.taskId,
          expectedTaskRevision: flow.revision,
        }),
      );
      expect(submitted).toMatchObject({ applied: true, task: { status: "submitted_unacked" } });

      const afterSubmitFlow = getTaskFlowById(flow.flowId)!;
      const running = recordExternalTaskEvent(
        makeEvent({
          eventId: "evt_2",
          eventType: "agent.started_work",
          flowId: flow.flowId,
          taskId: task.taskId,
          workerSeq: 2,
          observedAt: 1_778_090_009_000,
          expectedTaskRevision: afterSubmitFlow.revision,
        }),
      );
      expect(running).toMatchObject({ applied: true, task: { status: "running" } });

      const afterRunningFlow = getTaskFlowById(flow.flowId)!;
      const idle = recordExternalTaskEvent(
        makeEvent({
          eventId: "evt_3",
          eventType: "agent.idle_after_work",
          flowId: flow.flowId,
          taskId: task.taskId,
          workerSeq: 3,
          observedAt: 1_778_090_180_000,
          expectedTaskRevision: afterRunningFlow.revision,
          payload: { lastActivityAt: 1_778_090_000_000, idleMs: 180_000 },
        }),
      );
      expect(idle).toMatchObject({ applied: true, task: { status: "owner_check_required" } });
      expect(getTaskById(task.taskId)).toMatchObject({
        status: "owner_check_required",
        progressSummary: "Tmux agent went idle after work; owner check required.",
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "waiting",
        waitJson: expect.objectContaining({
          kind: "foreman.owner_check_required",
          reason: "idle_after_work",
          taskId: task.taskId,
        }),
      });
    });
  });

  it("rejects duplicate, stale revision, and worker sequence gap events", async () => {
    await withTaskStores(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:test",
        controllerId: "foreman/controller",
        goal: "Run external tmux assignment",
        stateJson: {
          foreman: { activeAttempt: { attemptId: "attempt_1", idempotencyKey: "idem_1" } },
        },
      });
      const task = createTaskRecord({
        runtime: "external-tmux",
        requesterSessionKey: flow.ownerKey,
        ownerKey: flow.ownerKey,
        parentFlowId: flow.flowId,
        task: "Submit prompt",
        status: "submitting",
      });

      const first = makeEvent({
        flowId: flow.flowId,
        taskId: task.taskId,
        expectedTaskRevision: flow.revision,
      });
      expect(recordExternalTaskEvent(first)).toMatchObject({ applied: true });
      expect(recordExternalTaskEvent(first)).toMatchObject({
        applied: false,
        reason: "duplicate_event",
      });
      expect(
        recordExternalTaskEvent(
          makeEvent({
            eventId: "evt_stale",
            flowId: flow.flowId,
            taskId: task.taskId,
            workerSeq: 2,
            expectedTaskRevision: flow.revision,
          }),
        ),
      ).toMatchObject({ applied: false, reason: "stale_revision" });
      const currentFlow = getTaskFlowById(flow.flowId)!;
      expect(
        recordExternalTaskEvent(
          makeEvent({
            eventId: "evt_gap",
            flowId: flow.flowId,
            taskId: task.taskId,
            workerSeq: 3,
            expectedTaskRevision: currentFlow.revision,
          }),
        ),
      ).toMatchObject({ applied: false, reason: "worker_seq_gap", expectedWorkerSeq: 2 });
    });
  });
});
