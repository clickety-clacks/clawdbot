# v2026.4.14 Conflict Report — 2026-04-14

This lane starts from the existing branch tip `487b56a029` (`clawline-v2026-4-11-merge`) and carries it forward onto upstream tag `v2026.4.14` (`323493fa1b6adc1e10b9954a68d5eaa5a6ef1170`).

Git reported textual conflicts only in generated artifacts:

- `pnpm-lock.yaml`
- `src/canvas-host/a2ui/.bundle.hash`

There were no textual conflicts in the Clawline extension tree, the runtime dependency staging seam, or the four plugin-sdk helper seams. The non-trivial manual resolutions for audit were:

## 1. Full Clawline extension tree

- **Files:** `extensions/clawline/**`
- **Upstream choice:** upstream `v2026.4.14` still has no Clawline extension tree
- **Carried-forward delta:** kept the full extension tree from the fork branch
- **Why load-bearing:** this is the actual Clawline product surface: channel registration, onboarding, config schema, provider runtime, outbound actions, session/stream handling, media/webroot behavior, terminal-bubble routing, and bundled skills
- **Verification:** `pnpm build`; targeted Clawline suite:
  - `extensions/clawline/src/actions.test.ts`
  - `extensions/clawline/src/channel.test.ts`
  - `extensions/clawline/src/config-schema.test.ts`
  - `extensions/clawline/src/entry.test.ts`
  - `extensions/clawline/src/outbound.test.ts`
  - `extensions/clawline/src/runtime/attachments.test.ts`
  - `extensions/clawline/src/runtime/config.test.ts`
  - `extensions/clawline/src/runtime/outbound.test.ts`
  - `extensions/clawline/src/runtime/per-user-task-queue.test.ts`
  - `extensions/clawline/src/runtime/rate-limiter.test.ts`
  - `extensions/clawline/src/runtime/server.test.ts`
  - `extensions/clawline/src/runtime/service.test.ts`
  - `extensions/clawline/src/runtime/session-keys.test.ts`
  - `extensions/clawline/src/runtime/session-store.test.ts`
  - `extensions/clawline/src/runtime/utils/deep-merge.test.ts`
- **Follow-up / blocker:** none

## 2. Bundled runtime dependency staging seam

- **Files:**
  - `scripts/stage-bundled-plugin-runtime-deps.mjs`
  - `test/scripts/stage-bundled-plugin-runtime-deps.test.ts`
- **Upstream choice:** keep upstream's staging script and test structure
- **Carried-forward delta:** retained only the lifecycle-install detection/fallback needed to avoid root-copy staging for packages that require install scripts
- **Why load-bearing:** Clawline depends on `better-sqlite3`; smooth plugin install/runtime still requires falling back to staged install when a runtime dependency needs lifecycle execution
- **Audit against upstream:** `v2026.4.14` still does not provide this fallback behavior generically; the seam remains required under Flynn's "smooth install/runtime" rule
- **Verification:**
  - `pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts`
  - `pnpm build`
- **Follow-up / blocker:** none

## 3. Minimal plugin-sdk runtime helper seams

- **Files:**
  - `src/plugin-sdk/agent-runtime.ts`
  - `src/plugin-sdk/config-runtime.ts`
  - `src/plugin-sdk/gateway-runtime.ts`
  - `src/plugin-sdk/reply-runtime.ts`
- **Upstream choice:** keep the current narrow subpath pattern; do not widen `src/plugin-sdk/index.ts`
- **Carried-forward delta:** retained only these four exports:
  - `enqueueAnnounce`
  - `resolveAllAgentSessionStoreTargetsSync`
  - `loadGatewayTlsRuntime`
  - `dispatchReplyFromConfig`
- **Why load-bearing:**
  - `enqueueAnnounce`: Clawline alert wakeups must join the shared announce queue; no other public plugin seam exposes that queue.
  - `resolveAllAgentSessionStoreTargetsSync`: Clawline session adoption/trackable-session views still need validated multi-agent store discovery without copying core policy.
  - `loadGatewayTlsRuntime`: Clawline provider startup still needs exact gateway TLS runtime behavior without duplicating cert/bootstrap logic.
  - `dispatchReplyFromConfig`: upstream added `src/plugin-sdk/inbound-reply-dispatch.ts`, but that helper family does not replace Clawline's direct use because Clawline still needs the current `replyResolver` injection and direct dispatch result (`queuedFinal`, counts) inside its provider runtime.
- **Audit against upstream:** re-checked `v2026.4.14`; no new public seam eliminates any of the four without either duplicating host internals or changing Clawline runtime behavior
- **Verification:**
  - `pnpm build` (`check-plugin-sdk-exports` passes)
  - `pnpm check`
  - targeted Clawline tests above, especially `extensions/clawline/src/runtime/server.test.ts`, `service.test.ts`, and `session-store.test.ts`
- **Follow-up / blocker:** none

## 4. Generated artifact conflicts resolved by regeneration

- **Files:**
  - `pnpm-lock.yaml`
  - `src/canvas-host/a2ui/.bundle.hash`
- **Upstream choice:** do not hand-merge generated artifacts
- **Carried-forward delta:** regenerated both artifacts from the merged tree
- **Why load-bearing:** the lockfile must reflect upstream `v2026.4.14` plus the carried-forward Clawline dependency set; `.bundle.hash` must reflect the actual build inputs after lockfile regeneration
- **Resolution method:**
  - deleted the conflicted worktree copies
  - ran `pnpm install` to regenerate `pnpm-lock.yaml`
  - ran `pnpm build` to regenerate `.bundle.hash`
- **Verification:** `pnpm build`
- **Follow-up / blocker:** one environment-only detour: `pnpm install` skipped the native `better-sqlite3` build, so `npm rebuild better-sqlite3 --foreground-scripts` was required before `extensions/clawline/src/runtime/server.test.ts` could pass

## 5. Restore rule re-check

- **Files evaluated:** prior fork-only core edits intentionally removed on the `v2026.4.11` lane
- **Upstream choice:** keep upstream defaults
- **Carried-forward delta:** none
- **Why load-bearing:** re-audit against `v2026.4.14` found no reason to revive the previously deleted seams (`src/config/defaults.ts`, `src/plugin-sdk/index.ts`, onboarding quickstart auto-enable, and other older fork edits)
- **Verification:** diff inventory against `v2026.4.14` still shows only the extension tree, staging seam, four plugin-sdk helpers, and generated artifacts
- **Follow-up / blocker:** none
