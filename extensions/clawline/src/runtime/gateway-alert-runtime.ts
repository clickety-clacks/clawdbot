import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";

export async function callClawlineGatewayAgent(params: {
  token?: string;
  request: {
    sessionKey: string;
    message: string;
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
    deliver: true;
    attachments?: unknown[];
    idempotencyKey: string;
  };
  timeoutMs?: number;
}) {
  return await callGatewayFromCli(
    "agent",
    {
      token: params.token,
      timeout: String(params.timeoutMs ?? 300_000),
      expectFinal: true,
      json: true,
    },
    params.request,
    {
      expectFinal: true,
      progress: false,
    },
  );
}

export async function callClawlineGatewaySessionSend(params: {
  token?: string;
  request: {
    sessionKey: string;
    message: string;
    attachments?: unknown[];
    idempotencyKey: string;
  };
  timeoutMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 300_000;
  const started = await callGatewayFromCli(
    "sessions.send",
    {
      token: params.token,
      timeout: String(timeoutMs),
      expectFinal: true,
      json: true,
    },
    {
      key: params.request.sessionKey,
      message: params.request.message,
      attachments: params.request.attachments,
      idempotencyKey: params.request.idempotencyKey,
    },
    {
      expectFinal: true,
      progress: false,
    },
  );
  const runId =
    started &&
    typeof started === "object" &&
    typeof (started as { runId?: unknown }).runId === "string"
      ? (started as { runId: string }).runId
      : "";
  if (!runId) {
    throw new Error("sessions.send did not return a runId");
  }
  const waited = await callGatewayFromCli(
    "agent.wait",
    {
      token: params.token,
      timeout: String(timeoutMs),
      expectFinal: true,
      json: true,
    },
    {
      runId,
      timeoutMs,
    },
    {
      expectFinal: true,
      progress: false,
    },
  );
  const status =
    waited &&
    typeof waited === "object" &&
    typeof (waited as { status?: unknown }).status === "string"
      ? (waited as { status: string }).status
      : "";
  if (status !== "ok") {
    const error =
      waited &&
      typeof waited === "object" &&
      typeof (waited as { error?: unknown }).error === "string"
        ? `: ${(waited as { error: string }).error}`
        : "";
    throw new Error(`sessions.send alert run did not complete${error}`);
  }
  return started && typeof started === "object"
    ? { ...started, status, wait: waited }
    : { runId, status, wait: waited };
}
