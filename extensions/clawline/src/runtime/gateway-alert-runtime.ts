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
