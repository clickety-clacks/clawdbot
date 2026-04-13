# v2026.4.11 Adversarial Review — 2026-04-12

This review compared the actual `clawline-v2026-4-11-merge` branch contents against `v2026.4.11` and the doctrine in `/Users/mike/shared-workspace/clawline/specs/v2026.4.11-merge-doctrine.md`.

## Verdict

The branch preserves Clawline function, matches upstream structure closely, and now carries a **Flynn-approved minimal core seam** for the few behaviors that still do not have an already-documented upstream public replacement on `v2026.4.11`.

## Prior Blocker Resolution

### 1. The four-helper seam is now the intended final carry-forward

- **Files:** `src/plugin-sdk/agent-runtime.ts`, `src/plugin-sdk/config-runtime.ts`, `src/plugin-sdk/gateway-runtime.ts`, `src/plugin-sdk/reply-runtime.ts`
- **Remaining helpers only:**
  - `enqueueAnnounce`
  - `resolveAllAgentSessionStoreTargetsSync`
  - `loadGatewayTlsRuntime`
  - `dispatchReplyFromConfig`
- **Status:** Flynn approved these four helpers as the final minimal core seam for this merge lane.
- **Adjudication:**
  - Functional: yes
  - Minimal: yes
  - Upstream-default: no
  - Approved: yes

## Final Approved Seam

Each surviving core touch is justified below in one sentence:

1. `enqueueAnnounce`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:4197`
   - **Justification:** Clawline alert wakeups must enter the same shared announce queue as core subagent announcements so idle gating and delivery ordering stay identical, and extension-only code cannot join that queue without a public enqueue seam.

2. `resolveAllAgentSessionStoreTargetsSync`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:5078`
   - **Justification:** Clawline trackable-session views must merge validated session stores across agent roots, and extension-only code would otherwise have to duplicate core discovery, symlink validation, and retired-agent-dir rules.

3. `loadGatewayTlsRuntime`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:1712`
   - **Justification:** Clawline must mirror gateway TLS startup behavior exactly for HTTPS/WSS enablement and failure reporting, and extension-only code would otherwise duplicate certificate generation, trusted-openssl lookup, and fingerprint handling.

4. `dispatchReplyFromConfig`
   - **Clawline use:** `extensions/clawline/src/runtime/server.ts:6678`, `extensions/clawline/src/runtime/server.ts:7148`
   - **Justification:** Clawline needs the current reply dispatch primitive with `replyResolver` injection for both normal messages and interactive callbacks, and the nearby public wrapper does not expose that hook without changing behavior.

## Non-Blocking Findings

### 1. The blocker shrank materially during the seam follow-up

- **Files changed during follow-up:** `extensions/clawline/src/runtime-api.ts`, `extensions/clawline/src/runtime/gateway-alert-runtime.ts`, `extensions/clawline/src/runtime/reply-compat.ts`, `extensions/clawline/src/runtime/session-compat.ts`
- **What changed:**
  - moved alert gateway delivery onto the existing `callGatewayFromCli` seam through an extension-local wrapper
  - re-homed queue settings, response-prefix model labels, queue-depth reads, session transcript paths, cron-run detection, default workspace path, main-session-key resolution, and flat session-entry merge behavior into extension-local compat helpers
  - updated focused Clawline tests to follow those local seams
  - reshaped the session-discovery export to flow through `src/config/sessions.js`, matching the newer upstream session-helper structure
- **Why this matters:**
  - the final seam is no longer a broad "plugin-sdk widening" complaint
  - the remaining core touches are the approved four-helper seam above

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
- **Minimize divergence:** substantially improved; the remaining divergence is down to four approved helpers
- **Restore upstream by default:** yes outside the approved minimal seam
- **Avoid invented core hooks:** satisfied under Flynn's explicit approval for the remaining minimal seam

## Flynn Review Readiness

This branch is ready for merge-to-main recommendation. The remaining four plugin-sdk public exports are now the intended final seam for this lane, and the branch no longer has an unresolved doctrine blocker under Flynn's approval.

## Verification Run

- `pnpm check`
- `pnpm build`
- `pnpm test extensions/clawline/src/runtime/service.test.ts extensions/clawline/src/runtime/session-store.test.ts extensions/clawline/src/runtime/server.test.ts -t "handles alert endpoint by waking gateway|forwards alert attachments through the wake queue to the gateway|startClawlineService|recordClawlineSessionActivity"`
