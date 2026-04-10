// Public gateway/client helpers for plugins that talk to the host gateway surface.

export { callGateway } from "../gateway/call.js";
export * from "../gateway/channel-status-patches.js";
export { GatewayClient } from "../gateway/client.js";
export { ADMIN_SCOPE } from "../gateway/method-scopes.js";
export {
  createOperatorApprovalsGatewayClient,
  withOperatorApprovalsGatewayClient,
} from "../gateway/operator-approvals-client.js";
export type { EventFrame } from "../gateway/protocol/index.js";
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
export { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
