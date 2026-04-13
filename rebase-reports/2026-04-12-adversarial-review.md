# v2026.4.11 Adversarial Review — 2026-04-12

This review compared the actual `clawline-v2026-4-11-merge` branch contents against `v2026.4.11` and the doctrine in `/Users/mike/shared-workspace/clawline/specs/v2026.4.11-merge-doctrine.md`.

## Verdict

The branch preserves Clawline function and is closer to the doctrine after review cleanup, but it is still **blocked** under the doctrine's strict A1 decision tree. The remaining plugin-sdk public-surface additions are functional, but they are not backed by an already-documented upstream public seam on `v2026.4.11`.

## Blockers

### 1. Remaining plugin-sdk public-surface expansion is still a doctrine blocker

- **Files:** `src/plugin-sdk/agent-runtime.ts`, `src/plugin-sdk/config-runtime.ts`, `src/plugin-sdk/gateway-runtime.ts`, `src/plugin-sdk/reply-runtime.ts`, `src/plugin-sdk/routing.ts`
- **Relevant lines:**
  - `src/plugin-sdk/agent-runtime.ts:19`, `src/plugin-sdk/agent-runtime.ts:24`
  - `src/plugin-sdk/config-runtime.ts:100`-`src/plugin-sdk/config-runtime.ts:115`
  - `src/plugin-sdk/gateway-runtime.ts:3`, `src/plugin-sdk/gateway-runtime.ts:6`, `src/plugin-sdk/gateway-runtime.ts:13`
  - `src/plugin-sdk/reply-runtime.ts:33`, `src/plugin-sdk/reply-runtime.ts:45`-`src/plugin-sdk/reply-runtime.ts:48`
  - `src/plugin-sdk/routing.ts:26`
- **Why this blocks doctrine compliance:**
  - Doctrine row A1 explicitly says the lane must adapt Clawline to an existing documented public `openclaw/plugin-sdk/*` seam when one exists.
  - If no equivalent public seam exists, the doctrine says to stop and escalate rather than invent a new ad hoc core hook during merge execution.
  - These exports are newly widened public seams on the branch. They keep Clawline compiling, but they are not upstream-default and they are not replacements that already existed on `v2026.4.11`.
- **Evidence that this is real branch behavior, not just report drift:**
  - `extensions/clawline/src/runtime/server.ts`
  - `extensions/clawline/src/runtime/service.ts`
  - `extensions/clawline/src/runtime/session-store.ts`
  - `extensions/clawline/src/runtime/config.ts`
  - `extensions/clawline/src/runtime-api.ts`
- **Adjudication:**
  - Functional: yes
  - Doctrine-clean: no
  - Required next step: Flynn decision or a different upstream-approved public seam plan

## Non-Blocking Findings

### 1. Two initial plugin-sdk widenings were unnecessary and were removed during review

- **Files changed during review:** `extensions/clawline/src/runtime-api.ts`, `src/plugin-sdk/infra-runtime.ts`, `src/plugin-sdk/media-runtime.ts`
- **What changed:**
  - moved `rawDataToString` to the existing `openclaw/plugin-sdk/browser-node-runtime` seam
  - moved `optimizeImageToJpeg` / `optimizeImageToPng` to the existing `openclaw/plugin-sdk/web-media` seam
  - restored `src/plugin-sdk/infra-runtime.ts` and `src/plugin-sdk/media-runtime.ts` to upstream
- **Why this matters:**
  - these were true minimize-divergence misses in the first integration pass
  - they no longer factor into the blocker list

### 2. `src/canvas-host/a2ui/.bundle.hash` drift is acceptable build-artifact drift

- **Files:** `src/canvas-host/a2ui/.bundle.hash`, `scripts/bundle-a2ui.mjs`, `pnpm-lock.yaml`
- **Assessment:**
  - non-blocking
  - the upstream bundler hashes `pnpm-lock.yaml`, and the doctrine explicitly required lockfile regeneration for the carried-forward dependency set
  - the artifact drift therefore follows from the required build inputs rather than from a Clawline-specific divergence in the A2UI pipeline

### 3. Engram checks were non-material

- Queried `src/plugin-sdk/agent-runtime.ts:1-40` and the provided `df32aaec-9bf7-486d-bae1-9faf9e263d4e` source id.
- The results were noisy/non-material and did not change the review outcome.

## Doctrine Fit

- **Preserve Clawline function:** yes
- **Adopt upstream patterns:** mostly yes, and improved during review by moving Clawline back to existing upstream public seams where available
- **Minimize divergence:** improved, but not fully satisfied because the remaining plugin-sdk exports still widen upstream public surface
- **Restore upstream by default:** mostly yes outside the remaining plugin-sdk blocker
- **Avoid invented core hooks:** not fully satisfied

## Flynn Review Readiness

This branch is ready for Flynn review **as a blocked doctrine decision**, not as a clean pass. If Flynn accepts the remaining plugin-sdk public-surface expansion as the intended carry-forward seam, the branch is otherwise in much better shape. If Flynn wants strict doctrine conformance, the lane still needs a different upstream-approved seam plan before it is ready to land.

## Verification Run

- `pnpm check`
- `pnpm build`
