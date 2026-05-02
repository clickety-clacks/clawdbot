// Clawline runtime files should import shared helpers from this barrel rather than
// reaching into repo internals directly. This barrel is intentionally limited to
// public `openclaw/plugin-sdk/*` subpaths.

export {
  buildAllowedModelSet,
  enqueueAnnounce,
  loadModelCatalog,
  resolveDefaultModelForAgent,
  resolveAgentIdentity,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "openclaw/plugin-sdk/agent-runtime";
export type { OpenClawConfig } from "openclaw/plugin-sdk/core";
export { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
export {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  applySessionsPatchToStore,
} from "openclaw/plugin-sdk/config-runtime";
export { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
export {
  createReplyDispatcherWithTyping,
  dispatchInboundMessage,
  finalizeInboundContext,
  getReplyFromConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
export { isLoopbackHost, rawDataToString } from "openclaw/plugin-sdk/browser-node-runtime";
export {
  closeDispatcher,
  createPinnedDispatcher,
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
  resolvePinnedHostname,
  type PinnedHostname,
} from "openclaw/plugin-sdk/infra-runtime";
export {
  detectMime,
  hasAlphaChannel,
  maxBytesForKind,
  mediaKindFromMime,
} from "openclaw/plugin-sdk/media-runtime";
export { optimizeImageToJpeg, optimizeImageToPng } from "openclaw/plugin-sdk/web-media";
export { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
export {
  resolveAllAgentSessionStoreTargetsSync,
  updateSessionStore,
} from "openclaw/plugin-sdk/config-runtime";

// Remaining gaps after T187:
// - Clawline runtime production code no longer reaches into repo `src/**`.
// - Test-only files still use a few direct core imports for types or focused mocks
//   where the plugin SDK does not yet expose a cleaner test seam.
