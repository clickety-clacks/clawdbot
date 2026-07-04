import { createServer, type Server } from "node:http";
import path from "node:path";
import { getTaskFlowById } from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { ForemanTaskFlowController, type ForemanWorkerEvent } from "./foreman-controller.js";
import {
  createForemanControllerHttpHandler,
  createForemanWorkerHttpHandler,
  ForemanFilePendingEventStore,
  ForemanFileWatchStore,
  ForemanLiveTransportController,
  ForemanTmuxWorker,
  type ForemanWorkerRegistration,
  LocalTmuxRunner,
} from "./foreman-live-transport.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "./types.js";

type ForemanWorkerConfig = ForemanWorkerRegistration & {
  token?: string;
  tokenRef?: string;
  defaultIdleAfterMs?: number;
  submitAckTimeoutMs?: number;
};

type ForemanPluginConfig = {
  controllerBaseUrl?: string;
  controllerEventsUrl?: string;
  eventToken?: string;
  eventTokenRef?: string;
  workers?: ForemanWorkerConfig[];
  worker?: {
    enabled?: boolean;
    hostId?: string;
    bindHost?: string;
    port?: number;
    token?: string;
    tokenRef?: string;
    pendingEventsFile?: string;
    watchesFile?: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readForemanPluginConfig(value: unknown): ForemanPluginConfig {
  return isRecord(value) ? (value as ForemanPluginConfig) : {};
}

function resolveControllerEventsUrl(config: ForemanPluginConfig): string {
  const explicit = stringValue(config.controllerEventsUrl);
  if (explicit) {
    return explicit;
  }
  const baseUrl = stringValue(config.controllerBaseUrl);
  return baseUrl ? new URL("/foreman/events", baseUrl).toString() : "/foreman/events";
}

function readWorkerRegistrations(
  config: ForemanPluginConfig,
): Map<string, ForemanWorkerRegistration> {
  const workers = new Map<string, ForemanWorkerRegistration>();
  for (const worker of Array.isArray(config.workers) ? config.workers : []) {
    const hostId = stringValue(worker.hostId);
    const baseUrl = stringValue(worker.baseUrl);
    if (!hostId || !baseUrl) {
      continue;
    }
    workers.set(hostId, {
      hostId,
      baseUrl,
      bearerToken: stringValue(worker.token) ?? stringValue(worker.tokenRef),
    });
  }
  return workers;
}

function readForemanStateOwner(flow: TaskFlowRecord | undefined): string | undefined {
  const state = flow?.stateJson;
  if (!isRecord(state) || state.foremanVersion !== 1) {
    return undefined;
  }
  return stringValue(state.ownerSessionKey) ?? stringValue(flow?.ownerKey);
}

function createForemanWorkerService(config: ForemanPluginConfig): OpenClawPluginService {
  let server: Server | null = null;
  return {
    id: "foreman-worker",
    start: async (ctx: OpenClawPluginServiceContext) => {
      const workerConfig = config.worker;
      if (!workerConfig?.enabled) {
        return;
      }
      if (server) {
        return;
      }
      const hostId = stringValue(workerConfig.hostId);
      const port = numberValue(workerConfig.port);
      if (!hostId || !port) {
        ctx.logger.warn("foreman worker service skipped: hostId and port are required");
        return;
      }
      const stateRoot = path.join(ctx.stateDir, "foreman", hostId);
      const worker = new ForemanTmuxWorker({
        hostId,
        tmux: new LocalTmuxRunner(),
        pendingEvents: new ForemanFilePendingEventStore(
          stringValue(workerConfig.pendingEventsFile) ??
            path.join(stateRoot, "pending-events.json"),
        ),
        watches: new ForemanFileWatchStore(
          stringValue(workerConfig.watchesFile) ?? path.join(stateRoot, "watches.json"),
        ),
      });
      const handler = createForemanWorkerHttpHandler({
        worker,
        bearerToken: stringValue(workerConfig.token) ?? stringValue(workerConfig.tokenRef),
      });
      server = createServer((req, res) => {
        void handler(req, res).then((handled) => {
          if (!handled && !res.headersSent) {
            res.writeHead(404).end();
          }
        });
      });
      await new Promise<void>((resolve) => {
        server?.listen(port, stringValue(workerConfig.bindHost) ?? "127.0.0.1", resolve);
      });
      await worker.flushPendingEvents({
        send: async (event: ForemanWorkerEvent) => {
          const sink = new URL(resolveControllerEventsUrl(config));
          await fetch(sink, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...((stringValue(config.eventToken) ?? stringValue(config.eventTokenRef))
                ? {
                    authorization: `Bearer ${
                      stringValue(config.eventToken) ?? stringValue(config.eventTokenRef)
                    }`,
                  }
                : {}),
            },
            body: JSON.stringify(event),
          });
        },
      });
      ctx.logger.info(
        `foreman worker service listening on ${stringValue(workerConfig.bindHost) ?? "127.0.0.1"}:${port}`,
      );
    },
    stop: async () => {
      const current = server;
      server = null;
      if (!current) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function registerForemanPluginRuntime(api: OpenClawPluginApi): void {
  const config = readForemanPluginConfig(api.pluginConfig);
  const controller = new ForemanTaskFlowController(api.runtime.taskFlow);
  const ownerByFlow = new Map<string, string>();
  const handler = createForemanControllerHttpHandler({
    controller,
    transport: new ForemanLiveTransportController({
      controller,
      workers: readWorkerRegistrations(config),
      controllerEventsUrl: resolveControllerEventsUrl(config),
      controllerBearerToken: stringValue(config.eventToken) ?? stringValue(config.eventTokenRef),
    }),
    workerBearerToken: stringValue(config.eventToken) ?? stringValue(config.eventTokenRef) ?? "",
    recordOwnerSessionKey: (flowId, ownerSessionKey) => {
      ownerByFlow.set(flowId, ownerSessionKey);
    },
    resolveOwnerSessionKey: (event) => {
      const flow = getTaskFlowById(event.flowId);
      return ownerByFlow.get(event.flowId) ?? readForemanStateOwner(flow);
    },
  });

  api.registerHttpRoute({
    path: "/foreman/flows",
    auth: "gateway",
    match: "exact",
    handler,
  });
  api.registerHttpRoute({
    path: "/foreman/events",
    auth: "plugin",
    match: "exact",
    handler,
  });
  api.registerService(createForemanWorkerService(config));
}

export type { ForemanPluginConfig };
