# v2026.4.11 Conflict Report — 2026-04-12

This lane started from upstream tag `v2026.4.11` (`769908ec3f713ecde067eb8c8aa54d8f57217aff`) and used doctrine-driven carry-forward instead of a direct merge. There were no textual git conflict markers. The non-trivial manual resolutions were:

## 1. Full Clawline extension tree

- **Files:** `extensions/clawline/**`
- **Upstream choice:** no Clawline extension exists on `v2026.4.11`
- **Carried-forward delta:** imported the full plugin tree from `origin/main`, excluding `extensions/clawline/AGENTS.md` and `extensions/clawline/CLAUDE.md`
- **Why load-bearing:** the doctrine marks the full product surface as mandatory
- **Verification:** `pnpm build`, `pnpm check`, `pnpm test extensions/clawline/src/actions.test.ts`, `pnpm test extensions/clawline/src/runtime/server.test.ts`, previously-run focused Clawline tests (`channel`, `config`, `service`, `session-store`, `entry`)
- **Follow-up / blocker:** none

## 2. Bundled plugin metadata and lockfile alignment

- **Files:** `extensions/clawline/package.json`, `pnpm-lock.yaml`
- **Upstream choice:** upstream has no Clawline package and no lockfile entries for its dependency set
- **Carried-forward delta:** aligned the plugin package with current bundled-plugin compatibility fields, added the missing development typings needed for `pnpm check`, and regenerated the lockfile from upstream plus the carried-forward dependency set
- **Why load-bearing:** doctrine requires workspace/build/test reachability and lockfile regeneration, not a wholesale lockfile copy
- **Verification:** `pnpm install`, `pnpm build`, `pnpm check`
- **Follow-up / blocker:** none

## 3. Runtime dependency staging seam

- **Files:** `scripts/stage-bundled-plugin-runtime-deps.mjs`, `test/scripts/stage-bundled-plugin-runtime-deps.test.ts`
- **Upstream choice:** upstream staging seam exists without the fork’s lifecycle-aware Clawline delta
- **Carried-forward delta:** ported only the lifecycle-aware staging behavior onto the upstream seam and kept the companion test coverage
- **Why load-bearing:** explicitly required by the doctrine to preserve bundled runtime dependency staging
- **Verification:** `pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts`, `pnpm build`
- **Follow-up / blocker:** none

## 4. Minimal plugin-sdk subpath compatibility exports

- **Files:** `src/plugin-sdk/agent-runtime.ts`, `src/plugin-sdk/config-runtime.ts`, `src/plugin-sdk/gateway-runtime.ts`, `src/plugin-sdk/reply-runtime.ts`
- **Upstream choice:** keep `src/plugin-sdk/index.ts` and the broader core surfaces upstream-default
- **Carried-forward delta:** after the seam follow-up, kept only four public subpath exports that Clawline still cannot source from existing upstream seams on `v2026.4.11`:
  - `enqueueAnnounce`
  - `resolveAllAgentSessionStoreTargetsSync`
  - `loadGatewayTlsRuntime`
  - `dispatchReplyFromConfig`
- **Why load-bearing:** Clawline still uses these helpers in `extensions/clawline/src/runtime/server.ts` for alert wakeups, merged session discovery, TLS startup parity, and reply dispatch
- **Verification:** `pnpm build` (including `check-plugin-sdk-exports`), `pnpm check`, `pnpm test extensions/clawline/src/runtime/service.test.ts extensions/clawline/src/runtime/session-store.test.ts extensions/clawline/src/runtime/server.test.ts -t "handles alert endpoint by waking gateway|forwards alert attachments through the wake queue to the gateway|startClawlineService|recordClawlineSessionActivity"`
- **Follow-up / blocker:** unresolved doctrine blocker. Row A1 in the merge doctrine requires the lane to adapt to an existing documented public seam or stop and escalate; these four exports do not have a pre-existing upstream public replacement on `v2026.4.11`, so the blocker became smaller and sharper rather than disappearing.

## 5. Alert attachment handling without widening a core queue contract

- **Files:** `extensions/clawline/src/runtime/server.ts`
- **Upstream choice:** leave `AnnounceQueueItem` upstream-default
- **Carried-forward delta:** used an extension-local `ClawlineAnnounceQueueItem` alias/cast so queued alert attachments keep working without reviving a fork-local core type expansion
- **Why load-bearing:** preserves Clawline alert attachment delivery while respecting the doctrine’s “no invented core hooks” rule
- **Verification:** `pnpm build`, `pnpm check`, `pnpm test extensions/clawline/src/runtime/server.test.ts`
- **Follow-up / blocker:** none

## 6. Upstream gate compatibility cleanup inside the carried-forward extension

- **Files:** `extensions/clawline/src/actions.ts`, `extensions/clawline/src/runtime/server.test.ts`
- **Upstream choice:** keep the stricter `v2026.4.11` lint/type/test gates
- **Carried-forward delta:** removed stale lint violations from the imported extension helpers, typed websocket test helpers to match actual object-frame usage, and updated one trackable-session expectation to include upstream `lastChannel`
- **Why load-bearing:** the lane must build and pass the repo gate on the upstream toolchain rather than depending on older fork lint assumptions
- **Verification:** `pnpm check`, `pnpm test extensions/clawline/src/actions.test.ts`, `pnpm test extensions/clawline/src/runtime/server.test.ts`
- **Follow-up / blocker:** none

## 7. Required build artifact drift

- **Files:** `src/canvas-host/a2ui/.bundle.hash`
- **Upstream choice:** keep the upstream A2UI bundling flow
- **Carried-forward delta:** accepted the regenerated bundle hash produced by the required build
- **Why load-bearing:** keeps the tree consistent with the required `pnpm build` output after the final carry-forward; `scripts/bundle-a2ui.mjs` hashes `pnpm-lock.yaml`, so the doctrine-required lockfile regeneration legitimately changes this artifact even when the bundle payload stays upstream-default
- **Verification:** a subsequent `pnpm build` reported `A2UI bundle up to date; skipping`
- **Follow-up / blocker:** none

## 8. Conditional quickstart auto-enable explicitly not carried

- **Files evaluated:** `src/commands/onboard-non-interactive/local.ts`, `src/commands/onboard-non-interactive.gateway.test.ts`
- **Upstream choice:** keep upstream default
- **Carried-forward delta:** none; the lane intentionally did not port the fork-local quickstart auto-enable behavior
- **Why load-bearing:** the doctrine allows this carry-forward only if it can be expressed through a clean upstream-compatible seam, which the current fork implementation does not satisfy
- **Verification:** doctrine review against `/Users/mike/shared-workspace/clawline/specs/v2026.4.11-merge-doctrine.md`
- **Follow-up / blocker:** none on this lane; revisit only if upstream adds a plugin-owned quickstart seam
