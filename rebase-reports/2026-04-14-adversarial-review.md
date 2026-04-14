# v2026.4.14 Adversarial Review — 2026-04-14

## Scope

- Reviewed the retained Clawline fork-side seam set for the `v2026.4.14` carry-forward lane.
- Primary audit target: what this lane keeps relative to upstream `v2026.4.14`, and what this lane newly changes relative to the prior branch tip `487b56a029`.

## Inputs

- `git diff --cached MERGE_HEAD -- extensions/clawline scripts/stage-bundled-plugin-runtime-deps.mjs src/plugin-sdk/agent-runtime.ts src/plugin-sdk/config-runtime.ts src/plugin-sdk/gateway-runtime.ts src/plugin-sdk/reply-runtime.ts test/scripts/stage-bundled-plugin-runtime-deps.test.ts`
- `git diff ORIG_HEAD -- scripts/stage-bundled-plugin-runtime-deps.mjs test/scripts/stage-bundled-plugin-runtime-deps.test.ts pnpm-lock.yaml src/canvas-host/a2ui/.bundle.hash`
- Call-site audit in `extensions/clawline/src/runtime/server.ts` and `extensions/clawline/src/runtime-api.ts`
- Verification gates:
  - `pnpm build`
  - `pnpm check`
  - `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test extensions/clawline/src/actions.test.ts extensions/clawline/src/channel.test.ts extensions/clawline/src/config-schema.test.ts extensions/clawline/src/entry.test.ts extensions/clawline/src/outbound.test.ts extensions/clawline/src/runtime/attachments.test.ts extensions/clawline/src/runtime/config.test.ts extensions/clawline/src/runtime/outbound.test.ts extensions/clawline/src/runtime/per-user-task-queue.test.ts extensions/clawline/src/runtime/rate-limiter.test.ts extensions/clawline/src/runtime/server.test.ts extensions/clawline/src/runtime/service.test.ts extensions/clawline/src/runtime/session-keys.test.ts extensions/clawline/src/runtime/session-store.test.ts extensions/clawline/src/runtime/utils/deep-merge.test.ts test/scripts/stage-bundled-plugin-runtime-deps.test.ts`

## External LLM Review Attempt

- Tried `codex exec -m gpt-5.2-codex ...` and `codex exec -m gpt-5.1-codex-max ...` first, per review workflow. This account did not support those models.
- Retried with `gpt-5.4`. The CLI captured a noisy partial transcript under `scratch/` and never produced a trustworthy final findings artifact for this lane.
- Result: external review attempt recorded, but the audit decision below relies on validated local evidence only.

## Engram Note

- Queried:
  - `engram explain src/plugin-sdk/agent-runtime.ts:1-40`
  - `engram explain src/plugin-sdk/config-runtime.ts:90-130`
  - `engram explain src/plugin-sdk/gateway-runtime.ts:1-20`
  - `engram explain src/plugin-sdk/reply-runtime.ts:20-40`
- Result: no provenance output was returned for these helper-export files.
- Influence on review: none.

## Findings

- No blocking findings.

## Validation Notes

- No new fork-only core seam was added on this lane beyond the already-approved seam set from the prior carry-forward branch.
- Relative to `ORIG_HEAD`, the only substantive code change is the upstream-shaped port of the bundled runtime dependency staging fallback plus its broader upstream test surface.
- The full `extensions/clawline/**` tree remains required because upstream still has no equivalent Clawline extension.
- The four retained Plugin SDK helper exports are still load-bearing at current call sites:
  - `enqueueAnnounce` used for alert wake queueing in `extensions/clawline/src/runtime/server.ts`
  - `resolveAllAgentSessionStoreTargetsSync` used for session-store target discovery in `extensions/clawline/src/runtime/server.ts`
  - `loadGatewayTlsRuntime` used for provider TLS startup in `extensions/clawline/src/runtime/server.ts`
  - `dispatchReplyFromConfig` used twice in `extensions/clawline/src/runtime/server.ts`, and upstream's newer reply-dispatch helper family still does not expose the same direct `replyResolver` plus result-count path
- The staged runtime dependency fallback remains justified by Flynn's keep-rule. `better-sqlite3` still required a native rebuild after install on this lane, and the updated staging test covers the lifecycle-install case explicitly.
- Generated artifact conflicts were handled by regeneration, not hand edits, which is the lowest-divergence resolution.

## Verdict

- Review result: ready for audit.
