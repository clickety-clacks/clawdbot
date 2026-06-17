# Clawline merge-recon feature manifest - 2026-06-16

Generated before merging upstream `v2026.6.8` into branch
`clawline-upmerge-v2026_6_8`.

Basis:
- Fork checkout branch: `clawline-upmerge-v2026_6_8`
- Current fork HEAD: `cafeb12450f42dfafb4bb13204ade6bfdad9632c`
- Target upstream tag: `v2026.6.8` at `4bf1a7d1e0a9189d10c7fbaf263d2ad537cd0760`
- Merge base with target tag: `b7a5bcba78861cf62545742a603a99676bbfa96a`
- Previous Clawline carry manifest read: `/Users/mike/.openclaw/workspace/clawline-changes-2026-06-08.md`
- Requested augmented recon report was not present at `/Users/mike/.openclaw/workspace/reports/rebase/openclaw-v2026.6.8-merge-recon.md`.

Scope note: the fork-side delta since the merge base contains normal fork history,
Clawline-owned extension files, and upstream-owned support carries. The merge
lane should treat raw conflicts as workload. Product risk is concentrated in the
documented Clawline footprint below, especially where Clawline still touches
upstream-owned core/support files.

## Clawline-owned extension footprint

### Bundled Clawline channel/service
- Files: `extensions/clawline/index.ts`, `extensions/clawline/service-api.ts`,
  `extensions/clawline/openclaw.plugin.json`, `extensions/clawline/package.json`,
  `extensions/clawline/src/channel.ts`, `extensions/clawline/src/channel.setup.ts`.
- Intent: keep Clawline as a bundled channel-like plugin whose runtime owns a
  long-lived HTTP/WebSocket/device service.
- Merge lens: preserve service lifecycle in the current upstream bundled-channel
  pattern. Do not add a new core hook unless the current pattern cannot express
  the service.

### Runtime server, protocol, state, and device trust
- Files: `extensions/clawline/src/runtime/server.ts`,
  `extensions/clawline/src/runtime/domain.ts`,
  `extensions/clawline/src/runtime/config.ts`,
  `extensions/clawline/src/runtime/rate-limiter.ts`,
  `extensions/clawline/src/runtime/session-store.ts`.
- Intent: preserve pairing, allowlist/denylist, token reissue, WebSocket auth,
  replay, stream sessions, adopted sessions, read state, SQLite migrations, and
  server-side CLU control APIs.
- Merge lens: keep the Clawline-specific state machine extension-homed. Adopt
  upstream auth/session fixes when they overlap with shared gateway behavior.

### Prompt turns, queueing, callbacks, and progress
- Files: `extensions/clawline/src/runtime/prompt-turn-state.ts`,
  `extensions/clawline/src/runtime/per-user-task-queue.ts`,
  `extensions/clawline/src/runtime/reply-compat.ts`,
  `extensions/clawline/src/actions.ts`,
  `extensions/clawline/src/runtime/server.ts`.
- Intent: preserve accepted/queued/running/delivered/canceled/failed prompt-turn
  projections, duplicate retry handling, startup recovery, callback turn
  ordering, prompt/control lane separation, and rich live `agent_progress`.
- Merge lens: prefer upstream channel-turn and progress callback patterns where
  available, but retain Clawline-visible state projections for mobile clients.

### Inbound context, reply references, media, and native delivery
- Files: `extensions/clawline/src/runtime/inbound-context.ts`,
  `extensions/clawline/src/runtime/message-reference-context.ts`,
  `extensions/clawline/src/runtime/attachments.ts`,
  `extensions/clawline/src/runtime/http-assets.ts`,
  `extensions/clawline/src/outbound.ts`,
  `extensions/clawline/src/runtime/outbound.ts`.
- Intent: preserve model-visible reply context, untrusted client context
  separation, attachments, uploads/downloads, generated image media lifting,
  and native Clawline outbound delivery.
- Merge lens: use upstream media and channel delivery contracts when equivalent;
  keep Clawline-specific media storage and native delivery inside the extension.

### Session controls, terminal bubbles, alerts, and webroot
- Files: `extensions/clawline/src/runtime/server.ts`,
  `extensions/clawline/src/runtime/gateway-alert-runtime.ts`,
  `extensions/clawline/src/runtime/system-events.ts`,
  `extensions/clawline/skills/*/SKILL.md`.
- Intent: preserve session status/control, model/thinking/fast-mode controls,
  terminal bubble lifecycle, `/alert` routing, system-event alert context, and
  local `/www` serving.
- Merge lens: if upstream now exposes a narrower SDK/control seam, migrate to it
  rather than carrying old private-shape code.

## Upstream-owned support carries

For each carry below, first ask whether upstream `v2026.6.8` absorbed the need.
If it did, take upstream exactly and remove the carry. If not, preserve the
Clawline intent in the new upstream pattern.

### Plugin SDK runtime seams
- Files: `src/plugin-sdk/agent-runtime.ts`,
  `src/plugin-sdk/agent-harness-runtime.ts`,
  `src/plugin-sdk/config-runtime.ts`,
  `src/plugin-sdk/gateway-runtime.ts`,
  `src/plugin-sdk/session-store-runtime.ts`,
  `src/plugin-sdk/ssrf-runtime.ts`,
  `src/plugin-sdk/system-event-runtime.ts`,
  `src/plugin-sdk/codex-app-server-control.ts`,
  `src/plugin-sdk/index.ts`, `scripts/lib/plugin-sdk-entrypoints.json`,
  `package.json`.
- Clawline intent: keep production Clawline code on public/runtime SDK subpaths
  instead of private `src/**` imports for agent/session/media/gateway helpers.
- Initial classification: `keep edge` / `needs seam`, depending on upstream
  exports after merge.

### Gateway protocol and legacy Clawline WebSocket compatibility
- Files: `src/gateway/protocol/schema/logs-chat.ts`,
  `src/gateway/server-methods/chat.ts`,
  `src/gateway/server/ws-connection/message-handler.ts`,
  `src/gateway/server/ws-connection/auth-context.ts`,
  `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`.
- Clawline intent: preserve `chat.send.references`, model-visible reply context,
  old native `{ type: "message" }` frames, legacy ack/error responses, and
  safe behavior under shared-auth rotation.
- Initial classification: `keep edge` for old native frames; `adopt now` for
  upstream provider-auth warmup/event-loop starvation fixes and auth/session
  invalidation behavior.

### Gateway/plugin config visibility
- Files: `src/gateway/runtime-plugin-config.ts`,
  `src/gateway/server.impl.ts`, `src/gateway/server-methods/channels.ts`,
  `src/gateway/server-methods/send.ts`,
  `src/plugins/current-plugin-metadata-snapshot.ts`,
  `src/channels/bundled-channel-catalog-read.ts`,
  `src/config/schema.ts`, `src/plugins/loader.ts`.
- Clawline intent: keep plugin-discovered Clawline channel config visible to
  gateway status/start/send/config paths and prevent external catalog metadata
  from hiding bundled Clawline.
- Initial classification: `adopt now` if upstream now resolves plugin runtime
  config generically; otherwise `keep edge` with minimal support carry.

### Agent runner, model/status, wait, and alert delivery
- Files: `src/agents/model-selection-shared.ts`, `src/agents/run-wait.ts`,
  `src/agents/pi-embedded-runner/run.ts`,
  `src/auto-reply/reply/agent-runner-execution.ts`,
  `src/auto-reply/get-reply-options.types.ts`,
  `src/auto-reply/reply/queue/types.ts`,
  `src/agents/subagent-announce-queue.ts`,
  `src/agents/subagent-announce-delivery.ts`.
- Clawline intent: preserve configured model picker truth, fast-mode/session
  status, terminal pending/error snapshots, explicit alert delivery, and
  ordered queued announcements.
- Initial classification: `adopt now` for upstream provider/auth warmup and
  event-loop starvation fixes; `keep edge` for Clawline-visible status/control
  facts not yet exposed by upstream.

### Media/reply path helpers
- Files: `src/auto-reply/reply/reply-media-paths.ts`,
  `src/auto-reply/reply/inbound-meta.ts`,
  `src/auto-reply/templating.ts`,
  `src/gateway/chat-display-projection.ts`.
- Clawline intent: preserve reply media aliases, workspace/media path handling,
  visible reply IDs, and bounded model-visible reference context.
- Initial classification: `keep edge` unless upstream has absorbed equivalent
  generic media/reference behavior.

### Package, build, native dependencies, and dist inventory
- Files: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`,
  `npm-shrinkwrap.json`, `tsdown.config.ts`,
  `scripts/lib/plugin-npm-package-manifest.mjs`,
  `scripts/prune-docker-plugin-dist.mjs`,
  `src/infra/package-dist-inventory.ts`.
- Clawline intent: keep `extensions/clawline` packaged with native runtime deps
  such as SQLite/PTY support and preserve runtime chunk/export behavior.
- Initial classification: `keep edge` for Clawline package/native dependency
  entries; take upstream exactly for unrelated release/package fixes.

### Native client/mobile surfaces
- Files: `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`,
  `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift`,
  `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`,
  related Swift tests.
- Clawline intent: preserve configured model listing, reply-reference protocol
  fields, and slash command behavior expected by Clawline mobile clients.
- Initial classification: `keep edge` unless upstream native client models now
  include equivalent fields and command semantics.

## Initial risk map for `v2026.6.8`

- Upstream changed provider auth, model/provider replay, and event-loop behavior;
  preserve those upstream fixes unless a documented Clawline carry directly
  requires an additive adaptation.
- Upstream changed delivery evidence, message-tool delivery hints, cron delivery
  target proof, and gateway usage/session behavior. Recheck Clawline alert and
  outbound delivery against current upstream patterns instead of preserving old
  queue hooks by shape.
- Upstream changed Telegram/status rich message line-break handling. This is not
  a Clawline footprint area; take upstream unless conflicts touch shared
  formatting utilities that Clawline directly uses.
- Upstream changed package/release/CI and plugin platform package behavior.
  Preserve Clawline package/native dependency entries, but take pure upstream
  release workflow behavior.

## Required post-merge proof plan

- Conflict/resolution report with: upstream changed, we changed, Clawline intent,
  still needed, chosen resolution, and why.
- Upstream-merge delta gate: list all files differing from `v2026.6.8`, split
  Clawline-owned additions from upstream-owned support deltas, and justify every
  upstream-owned delta.
- Focused Clawline tests around runtime server, prompt turns, inbound/reference
  context, outbound/media, queueing, SDK seams, gateway legacy frames/references,
  configured model visibility, and package/build support.
- Build proof before push. No deploy and no merge to main.
