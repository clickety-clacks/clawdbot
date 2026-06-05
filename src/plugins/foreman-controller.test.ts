import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskStatus } from "../tasks/task-registry.types.js";
import { ForemanTaskFlowController, type ForemanWorkerEvent } from "./foreman-controller.js";
import {
  createForemanControllerHttpHandler,
  ForemanHttpEventSink,
  ForemanFilePendingEventStore,
  ForemanFileWatchStore,
  ForemanLiveTransportController,
  ForemanMemoryPendingEventStore,
  ForemanMemoryWatchStore,
  ForemanTmuxWorker,
  ForemanWorkerHttpClient,
  toJsonResponse,
  type ForemanSubmitResponse,
  type ForemanSubmitRequest,
  type ForemanTmuxRunner,
  type ForemanWorkerEventSink,
} from "./foreman-live-transport.js";
import { registerForemanPluginRuntime } from "./foreman-plugin.js";
import type { PluginHttpRouteRegistration } from "./registry-types.js";
import {
  installRuntimeTaskDeliveryMock,
  resetRuntimeTaskTestState,
} from "./runtime/runtime-task-test-harness.js";
import { createRuntimeTaskFlow } from "./runtime/runtime-taskflow.js";

const ownerSessionKey = "agent:main:clawline:flynn:s_foreman";

function createController() {
  return new ForemanTaskFlowController(createRuntimeTaskFlow());
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createRouteServer(routes: PluginHttpRouteRegistration[]) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://openclaw.test");
    const route = routes.find(
      (entry) =>
        entry.path === url.pathname ||
        (entry.match === "prefix" && url.pathname.startsWith(entry.path)),
    );
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const handled = await route.handler(req, res);
    if (!handled && !res.headersSent) {
      res.writeHead(404).end();
    }
  });
}

async function waitForCondition(check: () => boolean | Promise<boolean>, turns = 20) {
  for (let index = 0; index < turns; index += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createSampleTmuxRunner(options: { workText?: string; idleText?: string } = {}): {
  runner: ForemanTmuxRunner;
  tmuxCalls: string[][];
} {
  const tmuxCalls: string[][] = [];
  const buffers = new Map<string, string>();
  let captureCount = 0;
  return {
    tmuxCalls,
    runner: {
      async execTmux(args) {
        tmuxCalls.push(args);
        if (args[0] === "list-sessions") {
          return { stdout: "sample-agent\n" };
        }
        if (args[0] === "set-buffer" && args[1] === "-b" && typeof args[2] === "string") {
          buffers.set(args[2], args[3] ?? "");
          return { stdout: "" };
        }
        if (args[0] === "show-buffer" && args[1] === "-b" && typeof args[2] === "string") {
          return { stdout: buffers.get(args[2]) ?? "" };
        }
        if (args[0] === "paste-buffer" && args[1] === "-d" && args[2] === "-b") {
          buffers.delete(args[3] ?? "");
          return { stdout: "" };
        }
        if (args[0] === "capture-pane") {
          captureCount += 1;
          return {
            stdout:
              captureCount === 1
                ? "Codex ready\n"
                : captureCount === 2
                  ? (options.workText ?? "Codex ready\nRunning command: pnpm test\n")
                  : (options.idleText ?? "Codex ready\n"),
          };
        }
        return { stdout: "" };
      },
    },
  };
}

describe("Foreman plugin-managed TaskFlow controller", () => {
  beforeEach(() => {
    installRuntimeTaskDeliveryMock();
  });

  afterEach(() => {
    resetRuntimeTaskTestState({ persist: false });
  });

  it("wires Foreman controller routes through the native plugin HTTP surface", async () => {
    const routes: PluginHttpRouteRegistration[] = [];
    const taskFlow = createRuntimeTaskFlow();
    let submittedToWorker: ForemanSubmitRequest | undefined;
    const workerServer = createServer(async (req, res) => {
      if (req.method !== "POST" || req.headers.authorization !== "Bearer worker-token") {
        writeJson(res, 401, { ok: false });
        return;
      }
      submittedToWorker = (await readJson(req)) as ForemanSubmitRequest;
      writeJson(res, 200, {
        ok: true,
        flowId: submittedToWorker.flowId,
        attemptId: submittedToWorker.attemptId,
        hostId: "worker-a",
        agentName: "sample-agent",
        phase: "submitted_to_pty",
        submittedAt: 123,
      });
    });
    const workerBaseUrl = await listen(workerServer);

    registerForemanPluginRuntime({
      id: "foreman",
      name: "Foreman",
      source: "bundled:foreman",
      registrationMode: "full",
      config: {},
      pluginConfig: {
        controllerEventsUrl: "http://127.0.0.1/foreman/events",
        eventToken: "event-token",
        workers: [{ hostId: "worker-a", baseUrl: workerBaseUrl, token: "worker-token" }],
      },
      runtime: { taskFlow },
      logger: { info() {}, warn() {}, error() {} },
      registerHttpRoute(route) {
        routes.push({
          pluginId: "foreman",
          source: "bundled:foreman",
          match: route.match ?? "exact",
          ...route,
        });
      },
      registerService() {},
    } as never);

    const routeServer = createRouteServer(routes);
    const routeBaseUrl = await listen(routeServer);
    try {
      const submitResponse = (await (
        await fetch(`${routeBaseUrl}/foreman/flows`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerSessionKey,
            goal: "native route proof",
            hostId: "worker-a",
            agentName: "sample-agent",
            prompt: "prove native route",
            idempotencyKey: "native-route-proof",
          }),
        })
      ).json()) as { ok: true; flowId: string; attemptId: string };

      expect(submitResponse).toMatchObject({ ok: true, phase: "submitted_to_pty" });
      expect(submittedToWorker).toMatchObject({
        controllerEventsUrl: "http://127.0.0.1/foreman/events",
        idempotencyKey: "native-route-proof",
      });

      const eventResponse = await fetch(`${routeBaseUrl}/foreman/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer event-token",
        },
        body: JSON.stringify({
          flowId: submitResponse.flowId,
          attemptId: submitResponse.attemptId,
          eventId: `${submitResponse.attemptId}:agent.prompt_submitted_to_pty:1`,
          eventType: "agent.prompt_submitted_to_pty",
          idempotencyKey: "native-route-proof",
          hostId: "worker-a",
          agentName: "sample-agent",
          workerSeq: 1,
        } satisfies ForemanWorkerEvent),
      });
      expect(eventResponse.status).toBe(200);
      const flow = taskFlow.bindSession({ sessionKey: ownerSessionKey }).get(submitResponse.flowId);
      expect(flow?.stateJson).toMatchObject({
        attempts: {
          [submitResponse.attemptId]: {
            phase: "submitted_to_pty",
          },
        },
      });
    } finally {
      await closeServer(routeServer);
      await closeServer(workerServer);
    }
  });

  it("returns a structured native route error for an unregistered worker", async () => {
    const routes: PluginHttpRouteRegistration[] = [];
    registerForemanPluginRuntime({
      id: "foreman",
      name: "Foreman",
      source: "bundled:foreman",
      registrationMode: "full",
      config: {},
      pluginConfig: {
        controllerEventsUrl: "http://127.0.0.1/foreman/events",
        eventToken: "event-token",
        workers: [],
      },
      runtime: { taskFlow: createRuntimeTaskFlow() },
      logger: { info() {}, warn() {}, error() {} },
      registerHttpRoute(route) {
        routes.push({
          pluginId: "foreman",
          source: "bundled:foreman",
          match: route.match ?? "exact",
          ...route,
        });
      },
      registerService() {},
    } as never);

    const routeServer = createRouteServer(routes);
    const routeBaseUrl = await listen(routeServer);
    try {
      const response = await fetch(`${routeBaseUrl}/foreman/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerSessionKey,
          goal: "native route proof",
          hostId: "missing-worker",
          agentName: "sample-agent",
          prompt: "prove native route",
          idempotencyKey: "native-route-missing-worker",
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "host_unreachable",
        retryable: false,
        recommendedAction: "ask_owner",
        message: "Foreman worker is not registered: missing-worker",
      });
    } finally {
      await closeServer(routeServer);
    }
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

    const submitted = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-1",
      eventType: "agent.prompt_submitted_to_pty",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 1,
      occurredAt: 1100,
    });
    expect(submitted).toMatchObject({ applied: true });

    const accepted = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-2",
      eventType: "agent.prompt_accepted",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 2,
      occurredAt: 1150,
    });
    expect(accepted).toMatchObject({ applied: true });

    const running = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-3",
      eventType: "agent.started_work",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 3,
      occurredAt: 1200,
    });
    expect(running).toMatchObject({ applied: true });

    const idle = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-4",
      eventType: "agent.idle_after_work",
      hostId: "worker-a",
      agentName: "ticket-agent",
      workerSeq: 4,
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
          lastWorkerEventId: "evt-4",
          lastWorkerSeq: 4,
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
          lastWorkerSeq: 4,
          lastEventType: "agent.idle_after_work",
        },
      },
      eventDedupe: {
        seenEventIds: ["evt-1", "evt-2", "evt-3", "evt-4"],
        lastSeqByAttempt: { "worker-a:attempt-1": 4 },
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
      eventType: "agent.prompt_submitted_to_pty" as const,
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
        eventId: "evt-idle-too-early",
        eventType: "agent.idle_after_work",
        workerSeq: 2,
      }),
    ).toMatchObject({ applied: false, reason: "invalid_phase_transition" });
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
      phase: "submitted_to_pty",
      lastWorkerSeq: 1,
      lastEventId: "evt-1",
    });
  });

  it("delivers controller submit to worker tmux action and returns idle-after-work to owner-check wait state", async () => {
    const controller = createController();
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    let now = 10_000;
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 250;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const eventResults: unknown[] = [];
    const workerEvents: ForemanWorkerEvent[] = [];

    const controllerEventsServer = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/foreman/events") {
        writeJson(res, 404, { ok: false });
        return;
      }
      const event = await readJson(req);
      workerEvents.push(event as ForemanWorkerEvent);
      const result = controller.applyWorkerEvent(ownerSessionKey, event as ForemanWorkerEvent);
      eventResults.push(result);
      writeJson(res, result.applied ? 200 : 409, {
        ok: result.applied,
        reason: result.reason,
        revision: result.applied ? result.flow.revision : undefined,
      });
    });
    const controllerEventsUrl = `${await listen(controllerEventsServer)}/foreman/events`;

    const workerServer = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/agents/sample-agent/submit") {
        writeJson(res, 404, { ok: false });
        return;
      }
      const body = (await readJson(req)) as ForemanSubmitRequest;
      const response = await worker.submit({
        ...body,
        agentName: "sample-agent",
      });
      const json = toJsonResponse(response);
      writeJson(res, json.status, json.body);
    });
    const workerBaseUrl = await listen(workerServer);

    try {
      const live = new ForemanLiveTransportController({
        controller,
        workers: new Map([["worker-a", { hostId: "worker-a", baseUrl: workerBaseUrl }]]),
        controllerEventsUrl,
      });

      const submitted = await live.submitAssignment({
        ownerSessionKey,
        goal: "prove sample-agent worked-to-idle owner check",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        attemptId: "attempt-live",
        idleAfterMs: 250,
        submitAckTimeoutMs: 1000,
        now: 9000,
      });

      expect(submitted).toMatchObject({
        ok: true,
        phase: "running",
        flow: { status: "running", currentStep: "foreman.tmux_submit" },
      });
      expect(tmuxCalls).toContainEqual(["set-buffer", "-b", "foreman_attempt-live", "submit work"]);
      expect(tmuxCalls).toContainEqual([
        "paste-buffer",
        "-d",
        "-b",
        "foreman_attempt-live",
        "-t",
        "sample-agent",
      ]);
      expect(tmuxCalls).toContainEqual(["send-keys", "-t", "sample-agent", "C-m"]);
      await waitForCondition(() => eventResults.length === 3);
      expect(eventResults).toHaveLength(3);
      expect(workerEvents.map((event) => event.eventType)).toEqual([
        "agent.prompt_submitted_to_pty",
        "agent.started_work",
        "agent.idle_after_work",
      ]);
      expect(workerEvents[1]?.payload).toMatchObject({
        detection: "tmux_pane_delta_active_work_evidence",
      });

      const summary = controller.summarize(ownerSessionKey, submitted.flow.flowId);
      expect(summary).toMatchObject({
        status: "waiting",
        currentStep: "foreman.owner_check",
        waitJson: {
          kind: "foreman.owner_check",
          reason: "idle_after_work",
          attemptId: "attempt-live",
          hostId: "worker-a",
          agentName: "sample-agent",
        },
        activeAttempt: {
          phase: "waiting_for_owner_check",
          lastWorkerSeq: 3,
          lastEventType: "agent.idle_after_work",
        },
      });
    } finally {
      await closeServer(workerServer);
      await closeServer(controllerEventsServer);
    }
  });

  it("routes Foreman flow submit and worker events through the controller HTTP handler", async () => {
    const controller = createController();
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    let now = 12_000;
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 250;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    let handler: ReturnType<typeof createForemanControllerHttpHandler> | undefined;
    const controllerServer = createServer(async (req, res) => {
      if (!handler || !(await handler(req, res))) {
        writeJson(res, 404, { ok: false });
      }
    });
    const controllerBaseUrl = await listen(controllerServer);
    const workerServer = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/agents/sample-agent/submit") {
        writeJson(res, 404, { ok: false });
        return;
      }
      const body = (await readJson(req)) as ForemanSubmitRequest;
      const response = await worker.submit({
        ...body,
        agentName: "sample-agent",
      });
      const json = toJsonResponse(response);
      writeJson(res, json.status, json.body);
    });
    const workerBaseUrl = await listen(workerServer);
    const transport = new ForemanLiveTransportController({
      controller,
      workers: new Map([["worker-a", { hostId: "worker-a", baseUrl: workerBaseUrl }]]),
      controllerEventsUrl: `${controllerBaseUrl}/foreman/events`,
      controllerBearerToken: "route-token",
    });
    handler = createForemanControllerHttpHandler({
      transport,
      controller,
      resolveOwnerSessionKey: () => ownerSessionKey,
      workerBearerToken: "route-token",
    });

    try {
      const response = await fetch(`${controllerBaseUrl}/foreman/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerSessionKey,
          goal: "route native Foreman flow",
          hostId: "worker-a",
          agentName: "sample-agent",
          prompt: "submit work",
          attemptId: "attempt-route",
          idempotencyKey: "idem-route",
          idleAfterMs: 250,
          submitAckTimeoutMs: 1000,
          now: 11_000,
        }),
      });
      const submitted = (await response.json()) as {
        ok: boolean;
        flow: { flowId: string };
        phase?: string;
      };

      expect(response.status).toBe(200);
      expect(submitted).toMatchObject({ ok: true, phase: "running" });
      expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
      const retryResponse = await fetch(`${controllerBaseUrl}/foreman/flows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerSessionKey,
          goal: "drifted retry metadata should not fork the flow",
          hostId: "worker-a",
          agentName: "sample-agent",
          prompt: "different retry prompt",
          idempotencyKey: "idem-route",
          idleAfterMs: 250,
          submitAckTimeoutMs: 1000,
          now: 11_500,
        }),
      });
      const retried = (await retryResponse.json()) as {
        ok: boolean;
        flow: { flowId: string };
        attemptId?: string;
      };

      expect(retryResponse.status).toBe(200);
      expect(retried).toMatchObject({
        ok: true,
        flow: { flowId: submitted.flow.flowId },
        attemptId: "attempt-route",
      });
      expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
      await waitForCondition(
        () => controller.summarize(ownerSessionKey, submitted.flow.flowId)?.status === "waiting",
      );
      expect(controller.summarize(ownerSessionKey, submitted.flow.flowId)).toMatchObject({
        status: "waiting",
        currentStep: "foreman.owner_check",
        activeAttempt: {
          phase: "waiting_for_owner_check",
          lastEventType: "agent.idle_after_work",
        },
      });
      const unauthorized = await fetch(`${controllerBaseUrl}/foreman/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await closeServer(workerServer);
      await closeServer(controllerServer);
    }
  });

  it("allows a route retry after controller-originated host_unreachable without poisoning worker sequence", async () => {
    const controller = createController();
    let submitCalls = 0;
    class RetryWorkerClient extends ForemanWorkerHttpClient {
      override async submit(
        _worker: { hostId: string; baseUrl: string; bearerToken?: string },
        agentName: string,
        body: ForemanSubmitRequest,
      ): Promise<ForemanSubmitResponse> {
        submitCalls += 1;
        if (submitCalls === 1) {
          return {
            ok: false,
            code: "host_unreachable",
            retryable: true,
            recommendedAction: "retry",
            message: "worker temporarily offline",
          };
        }
        const submitted = controller.applyWorkerEvent(ownerSessionKey, {
          flowId: body.flowId,
          attemptId: body.attemptId,
          eventId: `${body.attemptId}:agent.prompt_submitted_to_pty:1`,
          eventType: "agent.prompt_submitted_to_pty",
          idempotencyKey: body.idempotencyKey,
          hostId: "worker-a",
          agentName,
          workerSeq: 1,
          expectedFlowRevision: body.expectedFlowRevision,
          observedAt: 12_000,
        });
        if (!submitted.applied) {
          throw new Error(submitted.reason);
        }
        const started = controller.applyWorkerEvent(ownerSessionKey, {
          flowId: body.flowId,
          attemptId: body.attemptId,
          eventId: `${body.attemptId}:agent.started_work:2`,
          eventType: "agent.started_work",
          idempotencyKey: body.idempotencyKey,
          hostId: "worker-a",
          agentName,
          workerSeq: 2,
          expectedFlowRevision: submitted.flow.revision,
          observedAt: 12_250,
          payload: { detection: "tmux_pane_delta_active_work_evidence" },
        });
        if (!started.applied) {
          throw new Error(started.reason);
        }
        return {
          ok: true,
          flowId: body.flowId,
          attemptId: body.attemptId,
          hostId: "worker-a",
          agentName,
          phase: "running",
          submittedAt: 12_000,
          startedWorkAt: 12_250,
        };
      }
    }
    const transport = new ForemanLiveTransportController({
      controller,
      workerClient: new RetryWorkerClient(),
      workers: new Map([["worker-a", { hostId: "worker-a", baseUrl: "http://127.0.0.1" }]]),
      controllerEventsUrl: "http://127.0.0.1/foreman/events",
    });
    const input = {
      ownerSessionKey,
      goal: "retry after temporary worker outage",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      attemptId: "attempt-retry",
      idempotencyKey: "idem-retry",
      now: 11_000,
    };

    const unreachable = await transport.submitAssignment(input);
    expect(unreachable).toMatchObject({
      ok: false,
      code: "host_unreachable",
      flow: {
        status: "running",
        currentStep: "foreman.blocked",
      },
    });
    expect(controller.summarize(ownerSessionKey, unreachable.flow.flowId)).toMatchObject({
      activeAttempt: {
        phase: "blocked",
        blockedReason: "agent.host_unreachable",
        lastWorkerSeq: 0,
      },
    });

    const retried = await transport.submitAssignment({ ...input, now: 11_500 });

    expect(retried).toMatchObject({
      ok: true,
      phase: "running",
      flow: { flowId: unreachable.flow.flowId },
    });
    expect(controller.summarize(ownerSessionKey, unreachable.flow.flowId)).toMatchObject({
      status: "running",
      currentStep: "foreman.tmux_submit",
      activeAttempt: {
        phase: "running",
        blockedReason: null,
        lastWorkerSeq: 2,
        lastEventType: "agent.started_work",
      },
    });
  });

  it("worker submit sends tmux prompts only after finding a session with an agent signature", async () => {
    const sentEvents: unknown[] = [];
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        sentEvents.push(event);
      },
    };
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: {
        async execTmux(args) {
          if (args[0] === "list-sessions") {
            return { stdout: "sample-agent\n" };
          }
          if (args[0] === "capture-pane") {
            return { stdout: "plain shell\n$ " };
          }
          throw new Error(`unexpected tmux call: ${args.join(" ")}`);
        },
      },
    });

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-1",
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 100,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      sink,
    );

    expect(response).toMatchObject({ ok: false, code: "agent_not_detected" });
    expect(sentEvents).toMatchObject([
      {
        eventType: "agent.agent_not_detected",
        flowId: "flow-1",
        attemptId: "attempt-1",
        idempotencyKey: "idem-1",
      },
    ]);
  });

  it("worker submit returns same idempotent run without sending duplicate tmux keys", async () => {
    let now = 20_000;
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 100;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        return { revision: event.workerSeq + 1 };
      },
    };
    const request = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      idempotencyKey: "idem-1",
      expectedFlowRevision: 1,
      idleAfterMs: 100,
      submitAckTimeoutMs: 1000,
      controllerEventsUrl: "http://127.0.0.1/events",
    };

    const first = await worker.submitWithEventSink(request, sink);
    const second = await worker.submitWithEventSink(request, sink);

    expect(first).toMatchObject({ ok: true, phase: "running" });
    expect(second).toMatchObject({ ok: true, phase: "running", attemptId: "attempt-1" });
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
  });

  it("serializes concurrent same-idempotency submits without duplicate paste", async () => {
    let now = 25_000;
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 100;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const request = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      idempotencyKey: "idem-1",
      expectedFlowRevision: 1,
      idleAfterMs: 100,
      submitAckTimeoutMs: 1000,
      controllerEventsUrl: "http://127.0.0.1/events",
    };
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        return { revision: event.workerSeq + 1 };
      },
    };

    const [first, second] = await Promise.all([
      worker.submitWithEventSink(request, sink),
      worker.submitWithEventSink(request, sink),
    ]);

    expect(first).toMatchObject({ ok: true, phase: "running" });
    expect(second).toMatchObject({ ok: true, phase: "running" });
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
  });

  it("worker restart reuses tmux submission marker without duplicate paste", async () => {
    let now = 30_000;
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const createWorker = () =>
      new ForemanTmuxWorker({
        hostId: "worker-a",
        tmux: runner,
        sleep: async () => {
          now += 100;
        },
        now: () => {
          now += 100;
          return now;
        },
      });
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        return { revision: event.workerSeq + 1 };
      },
    };
    const request = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      idempotencyKey: "idem-1",
      expectedFlowRevision: 1,
      idleAfterMs: 100,
      submitAckTimeoutMs: 1000,
      controllerEventsUrl: "http://127.0.0.1/events",
    };

    const first = await createWorker().submitWithEventSink(request, sink);
    const second = await createWorker().submitWithEventSink(request, sink);

    expect(first).toMatchObject({ ok: true, phase: "running" });
    expect(second).toMatchObject({
      ok: true,
      phase: "submitted_to_pty",
      attemptId: "attempt-1",
    });
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
  });

  it("recreates a submitted watch from a tmux marker after restart", async () => {
    let now = 35_000;
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const watchStore = new ForemanMemoryWatchStore();
    const createWorker = (watches?: ForemanMemoryWatchStore) =>
      new ForemanTmuxWorker({
        hostId: "worker-a",
        tmux: runner,
        watches,
        sleep: async () => {
          now += 100;
        },
        now: () => {
          now += 100;
          return now;
        },
      });
    const request = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      idempotencyKey: "idem-1",
      expectedFlowRevision: 1,
      idleAfterMs: 100,
      submitAckTimeoutMs: 1000,
      controllerEventsUrl: "http://127.0.0.1/events",
    };
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        return { revision: event.workerSeq + 1 };
      },
    };

    await createWorker().submitWithEventSink(request, sink);
    const replayed = await createWorker(watchStore).submitWithEventSink(request, sink);

    expect(replayed).toMatchObject({ ok: true, phase: "submitted_to_pty" });
    expect(await watchStore.list()).toMatchObject([
      { attemptId: "attempt-1", phase: "submitted_to_pty" },
    ]);
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
  });

  it("keeps generic pane churn from becoming work-start and owner wake", async () => {
    let now = 40_000;
    const { runner, tmuxCalls } = createSampleTmuxRunner({
      workText: "Codex ready\nworking on submitted task\n",
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 100;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const sentEvents: ForemanWorkerEvent[] = [];
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        sentEvents.push(event);
        return { revision: event.workerSeq + 1 };
      },
    };

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-1",
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 300,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      sink,
    );

    expect(response).toMatchObject({ ok: false, code: "prompt_not_accepted" });
    expect(sentEvents.map((event) => event.eventType)).toEqual([
      "agent.prompt_submitted_to_pty",
      "agent.prompt_not_accepted",
    ]);
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(1);
  });

  it("does not treat echoed prompt text as work-start proof", async () => {
    let now = 45_000;
    const prompt = "Running command: pnpm test";
    const { runner } = createSampleTmuxRunner({
      workText: `Codex ready\n${prompt}\n`,
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 100;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const sentEvents: ForemanWorkerEvent[] = [];

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-1",
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt,
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 300,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          sentEvents.push(event);
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({ ok: false, code: "prompt_not_accepted" });
    expect(sentEvents.map((event) => event.eventType)).toEqual([
      "agent.prompt_submitted_to_pty",
      "agent.prompt_not_accepted",
    ]);
  });

  it("treats real Codex ran-command pane output as work-start evidence", async () => {
    let now = 47_000;
    const { runner } = createSampleTmuxRunner({
      workText: [
        "Codex ready",
        "› Foreman transport proof only.",
        "• Ran printf 'FOREMAN_SAMPLE_AGENT_WORK_STARTED\\n'",
        "  └ FOREMAN_SAMPLE_AGENT_WORK_STARTED",
      ].join("\n"),
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      sleep: async () => {
        now += 100;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    const sentEvents: ForemanWorkerEvent[] = [];

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-1",
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "Foreman transport proof only.",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 1000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          sentEvents.push(event);
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({ ok: true, phase: "running" });
    expect(sentEvents.map((event) => event.eventType).slice(0, 2)).toEqual([
      "agent.prompt_submitted_to_pty",
      "agent.started_work",
    ]);
    expect(sentEvents[1]?.payload).toMatchObject({
      detection: "tmux_pane_delta_active_work_evidence",
    });
  });

  it("queues idle-after-work when delivery fails and replays it later", async () => {
    let now = 50_000;
    const controller = createController();
    const flow = controller.createAssignment({
      ownerSessionKey,
      goal: "replay idle event",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      now,
    });
    const pendingEvents = new ForemanMemoryPendingEventStore();
    const { runner } = createSampleTmuxRunner();
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      pendingEvents,
      sleep: async () => {
        now += 250;
      },
      now: () => {
        now += 100;
        return now;
      },
    });
    let failIdleDelivery = true;
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        if (event.eventType === "agent.idle_after_work" && failIdleDelivery) {
          failIdleDelivery = false;
          throw new Error("controller temporarily unavailable");
        }
        const result = controller.applyWorkerEvent(ownerSessionKey, event);
        if (!result.applied) {
          throw new Error(result.reason);
        }
        return { revision: result.flow.revision };
      },
    };

    const response = await worker.submitWithEventSink(
      {
        flowId: flow.flowId,
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: flow.revision,
        idleAfterMs: 250,
        submitAckTimeoutMs: 10_000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      sink,
    );
    expect(response).toMatchObject({ ok: true, phase: "running" });
    await waitForCondition(async () => (await pendingEvents.list()).length === 1);
    expect(controller.summarize(ownerSessionKey, flow.flowId)).toMatchObject({
      status: "running",
      activeAttempt: { phase: "running" },
    });

    await worker.flushPendingEvents(sink);

    expect(await pendingEvents.list()).toHaveLength(0);
    expect(controller.summarize(ownerSessionKey, flow.flowId)).toMatchObject({
      status: "waiting",
      currentStep: "foreman.owner_check",
      activeAttempt: { phase: "waiting_for_owner_check" },
    });
  });

  it("continues replay after duplicate delivery clears a lost ack", async () => {
    const controller = createController();
    const flow = controller.createAssignment({
      ownerSessionKey,
      goal: "lost ack replay",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      now: 60_000,
    });
    const submittedEvent: ForemanWorkerEvent = {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "evt-1",
      eventType: "agent.prompt_submitted_to_pty",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      workerSeq: 1,
      expectedFlowRevision: flow.revision,
    };
    const appliedSubmitted = controller.applyWorkerEvent(ownerSessionKey, submittedEvent);
    if (!appliedSubmitted.applied) {
      throw new Error("submitted event was not applied");
    }
    const pendingEvents = new ForemanMemoryPendingEventStore();
    await pendingEvents.upsert({ event: submittedEvent });
    await pendingEvents.upsert({
      event: {
        ...submittedEvent,
        eventId: "evt-2",
        eventType: "agent.started_work",
        workerSeq: 2,
        expectedFlowRevision: flow.revision,
      },
    });
    await pendingEvents.upsert({
      event: {
        ...submittedEvent,
        eventId: "evt-3",
        eventType: "agent.idle_after_work",
        workerSeq: 3,
        expectedFlowRevision: flow.revision,
        idleMs: 100,
      },
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: createSampleTmuxRunner().runner,
      pendingEvents,
    });

    await worker.flushPendingEvents({
      async send(event) {
        const result = controller.applyWorkerEvent(ownerSessionKey, event);
        if (!result.applied) {
          if (result.reason === "duplicate_event" || result.reason === "stale_event") {
            return result.flow ? { revision: result.flow.revision } : {};
          }
          throw new Error(result.reason);
        }
        return { revision: result.flow.revision };
      },
    });

    expect(await pendingEvents.list()).toHaveLength(0);
    expect(controller.summarize(ownerSessionKey, flow.flowId)).toMatchObject({
      status: "waiting",
      activeAttempt: { phase: "waiting_for_owner_check", lastWorkerSeq: 3 },
    });
  });

  it("replays pending events with independent revision chains per attempt", async () => {
    const pendingEvents = new ForemanMemoryPendingEventStore();
    const firstEvent: ForemanWorkerEvent = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      eventId: "evt-flow-1",
      eventType: "agent.prompt_submitted_to_pty",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      workerSeq: 1,
      expectedFlowRevision: 11,
    };
    const secondEvent: ForemanWorkerEvent = {
      ...firstEvent,
      flowId: "flow-2",
      attemptId: "attempt-2",
      eventId: "evt-flow-2",
      idempotencyKey: "idem-2",
      expectedFlowRevision: 21,
    };
    await pendingEvents.upsert({ event: firstEvent });
    await pendingEvents.upsert({ event: secondEvent });
    const seenRevisions: Array<number | undefined> = [];
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: createSampleTmuxRunner().runner,
      pendingEvents,
    });

    await worker.flushPendingEvents({
      async send(event) {
        seenRevisions.push(event.expectedFlowRevision);
        return { revision: (event.expectedFlowRevision ?? 0) + 1 };
      },
    });

    expect(seenRevisions).toEqual([11, 21]);
    expect(await pendingEvents.list()).toHaveLength(0);
  });

  it("preserves controller revision from duplicate HTTP event acknowledgements", async () => {
    const sink = new ForemanHttpEventSink({
      url: "http://127.0.0.1/foreman/events",
      async fetch() {
        return new Response(JSON.stringify({ reason: "duplicate_event", revision: 7 }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      sink.send({
        flowId: "flow-1",
        attemptId: "attempt-1",
        eventId: "evt-1",
        eventType: "agent.prompt_submitted_to_pty",
        idempotencyKey: "idem-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        workerSeq: 1,
        expectedFlowRevision: 1,
      }),
    ).resolves.toEqual({ revision: 7 });
  });

  it("does not treat stale HTTP event acknowledgements as replay-safe delivery", async () => {
    const sink = new ForemanHttpEventSink({
      url: "http://127.0.0.1/foreman/events",
      async fetch() {
        return new Response(JSON.stringify({ reason: "stale_event", revision: 7 }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      sink.send({
        flowId: "flow-1",
        attemptId: "attempt-1",
        eventId: "evt-1",
        eventType: "agent.prompt_submitted_to_pty",
        idempotencyKey: "idem-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        workerSeq: 1,
        expectedFlowRevision: 1,
      }),
    ).rejects.toThrow("Foreman controller event delivery failed: HTTP 409");
  });

  it("persists pending worker events across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foreman-pending-"));
    const filePath = join(directory, "events.json");
    const firstStore = new ForemanFilePendingEventStore(filePath);
    const event: ForemanWorkerEvent = {
      flowId: "flow-1",
      attemptId: "attempt-1",
      eventId: "evt-1",
      eventType: "agent.idle_after_work",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      workerSeq: 3,
      expectedFlowRevision: 3,
    };
    await firstStore.upsert({ event });

    const secondStore = new ForemanFilePendingEventStore(filePath);
    const sentEvents: ForemanWorkerEvent[] = [];
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: createSampleTmuxRunner().runner,
      pendingEvents: secondStore,
    });

    await worker.flushPendingEvents({
      async send(sentEvent) {
        sentEvents.push(sentEvent);
        return { revision: 4 };
      },
    });

    expect(sentEvents).toEqual([event]);
    expect(await secondStore.list()).toHaveLength(0);
  });

  it("persists submitted watches across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foreman-watches-"));
    const filePath = join(directory, "watches.json");
    const firstStore = new ForemanFileWatchStore(filePath);
    await firstStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "submitted_to_pty",
      submittedAt: 80_000,
      paneTextBefore: "Codex ready\n",
      lastPaneText: "Codex ready\n",
      idleAfterMs: 250,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 1,
    });

    const secondStore = new ForemanFileWatchStore(filePath);
    expect(await secondStore.list()).toMatchObject([
      {
        attemptId: "attempt-1",
        phase: "submitted_to_pty",
        workerSeq: 1,
      },
    ]);
  });

  it("blocks a different submit when a restarted worker has a persisted watch", async () => {
    const watchStore = new ForemanMemoryWatchStore();
    const pendingEvents = new ForemanMemoryPendingEventStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "submitted_to_pty",
      submittedAt: 90_000,
      paneTextBefore: "Codex ready\n",
      lastPaneText: "Codex ready\n",
      idleAfterMs: 250,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 1,
    });
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const sentEvents: ForemanWorkerEvent[] = [];
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      pendingEvents,
      watches: watchStore,
    });

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-2",
        attemptId: "attempt-2",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "new work",
        idempotencyKey: "idem-2",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 1000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          sentEvents.push(event);
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({ ok: false, code: "agent_busy" });
    expect(sentEvents).toMatchObject([
      {
        eventType: "agent.agent_busy",
        payload: {
          reason: "persisted_foreman_watch",
          activeAttemptId: "attempt-1",
        },
      },
    ]);
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(0);
  });

  it("returns the original flow identity for same-idempotency persisted watch retries", async () => {
    const watchStore = new ForemanMemoryWatchStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "submitted_to_pty",
      submittedAt: 95_000,
      paneTextBefore: "Codex ready\n",
      lastPaneText: "Codex ready\n",
      idleAfterMs: 250,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 1,
    });
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      watches: watchStore,
    });

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-2",
        attemptId: "attempt-2",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 1000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({
      ok: true,
      flowId: "flow-1",
      attemptId: "attempt-1",
      phase: "submitted_to_pty",
    });
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(0);
  });

  it("returns same-idempotency persisted running watches without waiting for idle", async () => {
    const watchStore = new ForemanMemoryWatchStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "running",
      submittedAt: 95_000,
      startedWorkAt: 95_100,
      lastActivityAt: 95_200,
      paneTextBefore: "Codex ready\nRunning command: pnpm test\n",
      lastPaneText: "Codex ready\nRunning command: pnpm test\n",
      idleAfterMs: 60_000,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 2,
    });
    const { runner, tmuxCalls } = createSampleTmuxRunner();
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      watches: watchStore,
      sleep: async () => {
        throw new Error("retry response must not wait for idle polling");
      },
    });

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-2",
        attemptId: "attempt-2",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 100,
        submitAckTimeoutMs: 1000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({
      ok: true,
      flowId: "flow-1",
      attemptId: "attempt-1",
      phase: "running",
      startedWorkAt: 95_100,
    });
    expect(tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(0);
  });

  it("resumes a submitted watch after worker restart and reaches owner-check", async () => {
    let now = 70_000;
    const controller = createController();
    const watchStore = new ForemanMemoryWatchStore();
    const pendingEvents = new ForemanMemoryPendingEventStore();
    const flow = controller.createAssignment({
      ownerSessionKey,
      goal: "resume watcher",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      now,
    });
    const sink: ForemanWorkerEventSink = {
      async send(event) {
        const result = controller.applyWorkerEvent(ownerSessionKey, event);
        if (!result.applied) {
          throw new Error(result.reason);
        }
        return { revision: result.flow.revision };
      },
    };
    const submitted = controller.applyWorkerEvent(ownerSessionKey, {
      flowId: flow.flowId,
      attemptId: "attempt-1",
      eventId: "attempt-1:agent.prompt_submitted_to_pty:1",
      eventType: "agent.prompt_submitted_to_pty",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      workerSeq: 1,
      expectedFlowRevision: flow.revision,
      observedAt: now,
    });
    if (!submitted.applied) {
      throw new Error("submitted event was not applied");
    }
    await watchStore.upsert({
      flowId: flow.flowId,
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "submitted_to_pty",
      submittedAt: now,
      paneTextBefore: "Codex ready\n",
      lastPaneText: "Codex ready\n",
      idleAfterMs: 250,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: submitted.flow.revision,
      workerSeq: 1,
    });
    expect(await watchStore.list()).toMatchObject([{ phase: "submitted_to_pty", workerSeq: 1 }]);

    const resumedRunner = createSampleTmuxRunner();
    const resumedWorker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: resumedRunner.runner,
      pendingEvents,
      watches: watchStore,
      sleep: async () => {
        now += 250;
      },
      now: () => {
        now += 100;
        return now;
      },
    });

    await resumedWorker.resumePendingWatches(sink);

    expect(await watchStore.list()).toHaveLength(0);
    expect(resumedRunner.tmuxCalls.filter((args) => args[0] === "paste-buffer")).toHaveLength(0);
    expect(controller.summarize(ownerSessionKey, flow.flowId)).toMatchObject({
      status: "waiting",
      currentStep: "foreman.owner_check",
      activeAttempt: { phase: "waiting_for_owner_check", lastWorkerSeq: 3 },
    });
  });

  it("resumes running watches from persisted last activity time", async () => {
    let now = 1000;
    const watchStore = new ForemanMemoryWatchStore();
    const pendingEvents = new ForemanMemoryPendingEventStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "running",
      submittedAt: 0,
      startedWorkAt: 0,
      lastActivityAt: 900,
      paneTextBefore: "Codex ready\nRunning command: pnpm test\n",
      lastPaneText: "Codex ready\nRunning command: pnpm test\n",
      idleAfterMs: 500,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 2,
    });
    const tmuxCalls: string[][] = [];
    let captureCount = 0;
    const runner: ForemanTmuxRunner = {
      async execTmux(args) {
        tmuxCalls.push(args);
        if (args[0] === "capture-pane") {
          captureCount += 1;
          return {
            stdout:
              captureCount <= 1 ? "Codex ready\nRunning command: pnpm test\n" : "Codex ready\n",
          };
        }
        return { stdout: "" };
      },
    };
    const sentEvents: ForemanWorkerEvent[] = [];
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: runner,
      pendingEvents,
      watches: watchStore,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      pollIntervalMs: 250,
    });

    await worker.resumePendingWatches({
      async send(event) {
        sentEvents.push(event);
        return { revision: (event.expectedFlowRevision ?? 0) + 1 };
      },
    });

    expect(sentEvents).toMatchObject([
      {
        eventType: "agent.idle_after_work",
        observedAt: 2000,
        payload: { lastActivityAt: 1500, idleMs: 500 },
      },
    ]);
    expect(tmuxCalls.filter((args) => args[0] === "capture-pane")).toHaveLength(4);
  });

  it("does not wake owner while the latest pane evidence still says work is active", async () => {
    let now = 1000;
    let captureCount = 0;
    const watchStore = new ForemanMemoryWatchStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "running",
      submittedAt: 0,
      startedWorkAt: 0,
      lastActivityAt: 900,
      paneTextBefore: "Codex ready\nRunning command: pnpm test\n",
      lastPaneText: "Codex ready\nRunning command: pnpm test\n",
      idleAfterMs: 500,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 2,
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: {
        async execTmux(args) {
          if (args[0] === "capture-pane") {
            captureCount += 1;
            return {
              stdout:
                captureCount <= 2 ? "Codex ready\nRunning command: pnpm test\n" : "Codex ready\n",
            };
          }
          return { stdout: "" };
        },
      },
      watches: watchStore,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      pollIntervalMs: 250,
    });
    const sentEvents: ForemanWorkerEvent[] = [];

    await worker.resumePendingWatches({
      async send(event) {
        sentEvents.push(event);
        return { revision: (event.expectedFlowRevision ?? 0) + 1 };
      },
    });

    expect(sentEvents).toMatchObject([
      {
        eventType: "agent.idle_after_work",
        observedAt: 2250,
        payload: { lastActivityAt: 1750, idleMs: 500 },
      },
    ]);
    expect(captureCount).toBe(5);
  });

  it("keeps owner wake suppressed when active work evidence is near the pane tail", async () => {
    let now = 1000;
    let captureCount = 0;
    const activePaneTail = [
      "Codex ready",
      "Running command: pnpm test",
      "tokens: 12k",
      "status: still working",
    ].join("\n");
    const watchStore = new ForemanMemoryWatchStore();
    await watchStore.upsert({
      flowId: "flow-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      hostId: "worker-a",
      agentName: "sample-agent",
      prompt: "submit work",
      phase: "running",
      submittedAt: 0,
      startedWorkAt: 0,
      lastActivityAt: 900,
      paneTextBefore: activePaneTail,
      lastPaneText: activePaneTail,
      idleAfterMs: 500,
      submitAckTimeoutMs: 1000,
      expectedFlowRevision: 2,
      workerSeq: 2,
    });
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: {
        async execTmux(args) {
          if (args[0] === "capture-pane") {
            captureCount += 1;
            return {
              stdout: captureCount <= 2 ? activePaneTail : "Codex ready\n",
            };
          }
          return { stdout: "" };
        },
      },
      watches: watchStore,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      pollIntervalMs: 250,
    });
    const sentEvents: ForemanWorkerEvent[] = [];

    await worker.resumePendingWatches({
      async send(event) {
        sentEvents.push(event);
        return { revision: (event.expectedFlowRevision ?? 0) + 1 };
      },
    });

    expect(sentEvents).toMatchObject([
      {
        eventType: "agent.idle_after_work",
        observedAt: 2250,
        payload: { lastActivityAt: 1750, idleMs: 500 },
      },
    ]);
    expect(captureCount).toBe(5);
  });

  it("reports lost pane evidence when an idle watcher cannot capture tmux", async () => {
    let now = 2_000;
    let captureCount = 0;
    const sentEvents: ForemanWorkerEvent[] = [];
    const worker = new ForemanTmuxWorker({
      hostId: "worker-a",
      tmux: {
        async execTmux(args) {
          if (args[0] === "list-sessions") {
            return { stdout: "sample-agent\n" };
          }
          if (args[0] === "set-buffer" || args[0] === "paste-buffer" || args[0] === "send-keys") {
            return { stdout: "" };
          }
          if (args[0] === "show-buffer") {
            return { stdout: "submit work" };
          }
          if (args[0] === "capture-pane") {
            captureCount += 1;
            if (captureCount === 1) {
              return { stdout: "Codex ready\n" };
            }
            if (captureCount === 2) {
              return { stdout: "Codex ready\nRunning command: pnpm test\n" };
            }
            throw new Error("pane disappeared");
          }
          return { stdout: "" };
        },
      },
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
      pollIntervalMs: 100,
    });

    const response = await worker.submitWithEventSink(
      {
        flowId: "flow-1",
        attemptId: "attempt-1",
        hostId: "worker-a",
        agentName: "sample-agent",
        prompt: "submit work",
        idempotencyKey: "idem-1",
        expectedFlowRevision: 1,
        idleAfterMs: 500,
        submitAckTimeoutMs: 1000,
        controllerEventsUrl: "http://127.0.0.1/events",
      },
      {
        async send(event) {
          sentEvents.push(event);
          return { revision: event.workerSeq + 1 };
        },
      },
    );

    expect(response).toMatchObject({ ok: true, phase: "running" });
    await waitForCondition(() =>
      sentEvents.some((event) => event.eventType === "agent.session_not_found"),
    );
    expect(sentEvents.map((event) => event.eventType)).toEqual([
      "agent.prompt_submitted_to_pty",
      "agent.started_work",
      "agent.session_not_found",
    ]);
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
