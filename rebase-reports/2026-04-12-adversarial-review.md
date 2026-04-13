# v2026.4.11 Adversarial Review — 2026-04-12

This review compared the actual `clawline-v2026-4-11-merge` branch contents against `v2026.4.11` and the doctrine in `/Users/mike/shared-workspace/clawline/specs/v2026.4.11-merge-doctrine.md`.

## Verdict

The branch preserves Clawline function and now matches the doctrine much more closely after a second reduction pass, but it is still **blocked** under the doctrine's strict A1 decision tree. The blocker is now a short, explicit list of four remaining plugin-sdk public-surface additions that do not have an already-documented upstream public replacement seam on `v2026.4.11`.

## Blockers

### 1. Four remaining plugin-sdk exports are still a doctrine blocker

- **Files:** `src/plugin-sdk/agent-runtime.ts`, `src/plugin-sdk/config-runtime.ts`, `src/plugin-sdk/gateway-runtime.ts`, `src/plugin-sdk/reply-runtime.ts`
- **Remaining helpers only:**
  - `enqueueAnnounce`
  - `resolveAllAgentSessionStoreTargetsSync`
  - `loadGatewayTlsRuntime`
  - `dispatchReplyFromConfig`
- **Why this still blocks doctrine compliance:**
  - Doctrine row A1 says the lane must adapt Clawline to an existing documented public `openclaw/plugin-sdk/*` seam when one exists.
  - If no equivalent public seam exists, the doctrine says to stop and escalate rather than invent a new ad hoc core hook during merge execution.
  - These four exports are the only remaining widened public seams on the branch. They keep Clawline compiling and behaving correctly, but they are not upstream-default and they are not replacements that already existed on `v2026.4.11`.
- **Adjudication:**
  - Functional: yes
  - Doctrine-clean: no
  - Required next step: Flynn decision or a different upstream-approved seam

## Remaining Seam Plan

If Flynn wants strict doctrine compliance, the remaining seam work is now explicit:

1. `enqueueAnnounce`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:4197`
   - **Why it remains:** Clawline alert wakeups intentionally use the same announce queue the core uses for subagent announcements so alerts drain under the same idle/ordering behavior.
   - **Why no upstream seam suffices:** there is no existing upstream public seam for "enqueue one announce item onto the shared announce queue." Re-homing this locally would fork queue semantics rather than migrate to an upstream-owned interface.

2. `resolveAllAgentSessionStoreTargetsSync`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:5078`
   - **Why it remains:** Clawline merges visible session stores across agent roots before building trackable-session responses.
   - **Why no upstream seam suffices:** upstream exposes ordinary single-store helpers, but no existing public seam exposes the validated multi-agent discovery walk. Replacing it locally would require copying the current discovery policy, symlink validation, and retired-agent-dir behavior.

3. `loadGatewayTlsRuntime`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:1712`
   - **Why it remains:** Clawline mirrors gateway TLS runtime behavior when deciding whether to start HTTPS/WSS and when surfacing TLS startup failures.
   - **Why no upstream seam suffices:** there is no existing upstream public TLS-runtime helper on another documented plugin-sdk subpath. Re-homing it locally would duplicate gateway certificate generation, trusted-openssl lookup, and fingerprint normalization behavior.

4. `dispatchReplyFromConfig`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:6678`, `extensions/clawline/src/runtime/server.ts:7148`
   - **Why it remains:** Clawline needs the current reply dispatch primitive with its custom `replyResolver` injection and existing dispatcher behavior for both normal messages and interactive callbacks.
   - **Why no upstream seam suffices:** the nearby upstream public helper `dispatchReplyFromConfigWithSettledDispatcher` does not expose the `replyResolver` hook Clawline currently uses, so migrating to it would change behavior rather than just re-home imports.

## Non-Blocking Findings

### 1. The blocker shrank materially during the seam follow-up

- **Files changed during follow-up:** `extensions/clawline/src/runtime-api.ts`, `extensions/clawline/src/runtime/gateway-alert-runtime.ts`, `extensions/clawline/src/runtime/reply-compat.ts`, `extensions/clawline/src/runtime/session-compat.ts`
- **What changed:**
  - moved alert gateway delivery onto the existing `callGatewayFromCli` seam through an extension-local wrapper
  - re-homed queue settings, response-prefix model labels, queue-depth reads, session transcript paths, cron-run detection, default workspace path, main-session-key resolution, and flat session-entry merge behavior into extension-local compat helpers
  - updated focused Clawline tests to follow those local seams
- **Why this matters:**
  - the blocker is no longer a broad "plugin-sdk widening" complaint
  - the remaining issue is now the four-helper seam plan above

### 2. `src/canvas-host/a2ui/.bundle.hash` drift is acceptable build-artifact drift

- **Files:** `src/canvas-host/a2ui/.bundle.hash`, `scripts/bundle-a2ui.mjs`, `pnpm-lock.yaml`
- **Assessment:**
  - non-blocking
  - the upstream bundler hashes `pnpm-lock.yaml`, and the doctrine explicitly required lockfile regeneration for the carried-forward dependency set
  - the artifact drift therefore follows from the required build inputs rather than from a Clawline-specific divergence in the A2UI pipeline

### 3. Engram checks sharpened the blocker, but did not clear it

- Queried `src/auto-reply/reply/dispatch-from-config.ts:201-260` and `src/agents/subagent-announce-queue.ts:212-237`, plus the provided source ids.
- The results did not produce a new upstream seam, but they did reinforce that `dispatchReplyFromConfig` and `enqueueAnnounce` are tied to real shared core behavior rather than being easy cosmetic wrappers.

## Doctrine Fit

- **Preserve Clawline function:** yes
- **Adopt upstream patterns:** mostly yes, and improved during review by moving Clawline back to existing upstream public seams where available
- **Minimize divergence:** substantially improved; the remaining divergence is down to four helpers
- **Restore upstream by default:** mostly yes outside the remaining plugin-sdk blocker
- **Avoid invented core hooks:** not fully satisfied until the remaining four-helper seam question is resolved

## Flynn Review Readiness

This branch is ready for Flynn review **as a narrower blocked doctrine decision**, not as a clean pass. If Flynn accepts the remaining four plugin-sdk public-surface additions as the intended carry-forward seam, the branch is otherwise in good shape. If Flynn wants strict doctrine conformance, the lane still needs a different upstream-approved seam for those four helpers before it is ready to land.

## Verification Run

- `pnpm check`
- `pnpm build`
- `pnpm test extensions/clawline/src/runtime/service.test.ts extensions/clawline/src/runtime/session-store.test.ts extensions/clawline/src/runtime/server.test.ts -t "handles alert endpoint by waking gateway|forwards alert attachments through the wake queue to the gateway|startClawlineService|recordClawlineSessionActivity"`
