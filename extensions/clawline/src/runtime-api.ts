// Clawline runtime files should import shared helpers from this barrel rather than
// reaching into repo internals directly. This barrel is intentionally limited to
// public `openclaw/plugin-sdk/*` subpaths and package-owned runtime APIs.

export {
  buildAllowedModelSet,
  enqueueAnnounce,
  loadModelCatalog,
  listThinkingLevelOptions,
  resolveAgentHarnessPolicy,
  resolveDefaultModelForAgent,
  resolveAgentWorkspaceDir,
  resolveAgentIdentity,
  resolveEffectiveMessagesConfig,
  resolveModelAuthMode,
  resolveHumanDelayConfig,
} from "openclaw/plugin-sdk/agent-runtime";
export type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
export {
  abortAgentHarnessRun,
  inferToolMetaFromArgs,
  resolveActiveAgentHarnessRunSessionId,
} from "openclaw/plugin-sdk/agent-harness-runtime";
export type { OpenClawConfig } from "openclaw/plugin-sdk/core";
export { resolveUserPath } from "openclaw/plugin-sdk/account-resolution";
export {
  applySessionsPatchToStore,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreEntry,
  resolveStorePath,
  updateSessionStore,
} from "openclaw/plugin-sdk/session-store-runtime";
export { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
export {
  createReplyDispatcherWithTyping,
  dispatchInboundMessage,
  finalizeInboundContext,
  getReplyFromConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
export { isLoopbackHost, rawDataToString } from "openclaw/plugin-sdk/gateway-runtime";
export {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  type PinnedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
export {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
export {
  detectMime,
  hasAlphaChannel,
  maxBytesForKind,
  mediaKindFromMime,
} from "openclaw/plugin-sdk/media-runtime";
export {
  getDefaultLocalRoots,
  loadWebMedia,
  optimizeImageToJpeg,
  optimizeImageToPng,
} from "openclaw/plugin-sdk/web-media";
export { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
export { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
export {
  prepareProviderUsageBinding,
  ProviderUsageBindingError,
  type PreparedProviderUsageBinding,
  type ProviderUsageFetchResult,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
export {
  DEFAULT_ACCOUNT_ID,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
export {
  readCodexConversationFastMode,
  setCodexConversationFastMode,
  type CodexConversationFastModeStatus,
} from "@openclaw/codex/runtime-api.js";

// Remaining gaps after T187:
// - Clawline runtime production code no longer reaches into repo `src/**`.
// - Test-only files still use a few direct core imports for types or focused mocks
//   where the plugin SDK does not yet expose a cleaner test seam.
