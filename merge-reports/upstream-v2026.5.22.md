# Upstream v2026.5.22 Merge Report

Branch: `clawline-upstream-v2026-5-22-merge`
Upstream tag: `v2026.5.22` (`a374c3a5bf`)
Merge base before merge: `3e71dd0dc0`

## Merge Resolution

The merge was performed with upstream-biased conflict resolution (`git merge -X theirs --no-commit v2026.5.22`) after a plain merge produced hundreds of version, generated, workflow, and plugin-package conflicts.

Hard conflicts left by the upstream-biased merge:

- `extensions/openai/cli-backend.ts` - deleted upstream, modified locally. Resolved upstream-delete-wins.
- `extensions/canvas/src/host/a2ui/.bundle.hash` - deleted upstream, modified locally. Resolved upstream-delete-wins.
- `patches/baileys@7.0.0-rc11.patch` - deleted upstream after local rename from `rc10`. Resolved upstream-delete-wins.

One mechanical merge artifact was fixed after conflict resolution:

- `src/agents/subagent-announce-delivery.ts` had a duplicated `runAnnounceAgentCall` helper; the duplicate copy was removed with no behavior change.

## Clawline Carries Retained

The branch still carries the first-party Clawline plugin package and runtime:

- `extensions/clawline/**`
- `extensions/clawline/openclaw.plugin.json`
- `extensions/clawline/package.json`
- workspace/build inclusion in `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `tsdown.config.ts`

The branch also retains core/SDK seams used by that plugin or by Clawline-visible product behavior:

- `src/plugin-sdk/codex-app-server-control.ts` and `src/plugin-sdk/index.ts`: Codex app-server control surface used by `extensions/codex/src/conversation-control.ts`.
- `src/plugin-sdk/{agent-runtime,gateway-runtime,config-runtime,session-store-runtime,ssrf-runtime,system-event-runtime}.ts`: public SDK runtime exports consumed by plugin runtime code.
- `src/auto-reply/reply/reply-media-paths.ts`: media path normalization for local/workspace media delivery.
- `src/infra/heartbeat-runner.ts`: heartbeat/tool-response suppression and relay behavior.
- `src/agents/subagent-announce-delivery.ts`: gateway-backed subagent announcement delivery.
- `apps/shared/OpenClawKit/**` and `apps/{ios,macos}/**`: Clawline client-facing session and transport behavior.

## Core-Footprint Removal Status

These statuses are based on the merged source, not on the hypothesis that upstream plugin-dev features make removal safe.

| Seam                               | Status                                                                   | Evidence                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clawline channel/runtime package   | Satisfied for package boundary, unsatisfied for complete extraction      | Runtime is isolated under `extensions/clawline/**`, but build/workspace/package surfaces still include it as a first-party package.                                                                     |
| Codex session controls / fast mode | Unsatisfied                                                              | `extensions/codex/src/conversation-control.ts` imports `openclaw/plugin-sdk/codex-app-server-control`, and the SDK file is still carried in core.                                                       |
| Plugin SDK runtime seams           | Unsatisfied                                                              | `src/plugin-sdk/*-runtime.ts` exports are still carried for Clawline runtime consumption and package contract tests.                                                                                    |
| Session/transcript compatibility   | Unsatisfied                                                              | Clawline runtime owns compatibility helpers under `extensions/clawline/src/runtime/session-compat.ts`, while client/shared session behavior still has core/app changes in `apps/shared/OpenClawKit/**`. |
| Message reference context          | Satisfied for Clawline-local resolver, unproven for full product removal | Reference resolution implementation is under `extensions/clawline/src/runtime/message-reference-context.ts`; no proof yet that all non-plugin call sites and client expectations are removable.         |
| Media/reference delivery           | Unsatisfied                                                              | Core reply media path normalization still carries workspace/local media handling in `src/auto-reply/reply/reply-media-paths.ts`.                                                                        |
| Heartbeat and subagent delivery    | Unsatisfied                                                              | `src/infra/heartbeat-runner.ts` and `src/agents/subagent-announce-delivery.ts` still contain behavior used by Clawline-visible session delivery flows.                                                  |
| Package/plugin/build packaging     | Unsatisfied                                                              | `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsdown.config.ts`, and package acceptance tests still carry Clawline/plugin packaging behavior.                                                               |

Conclusion: core-footprint removal remains unproven overall. This branch exposes the remaining seams; it does not prove they can be removed.

## Validation Log

- `pnpm install` - passed. The first install reported the merged `pnpm-lock.yaml` had a duplicate `libsignal@6.0.0` key and regenerated a valid lockfile.
- `pnpm test extensions/codex/src/conversation-control.test.ts src/gateway/session-history-state.test.ts src/gateway/session-message-events.test.ts src/gateway/sessions-history-http.test.ts src/auto-reply/reply/reply-media-paths.test.ts extensions/clawline/src/runtime/message-reference-context.test.ts extensions/clawline/src/runtime/sdk-seams.test.ts src/plugins/sdk-alias.test.ts test/scripts/package-acceptance-workflow.test.ts src/infra/tsdown-config.test.ts` - passed, 7 Vitest shards / 161 tests.
- `pnpm check:no-conflict-markers` - passed.
- `pnpm plugin-sdk:check-exports` - passed.
- `pnpm build` - passed.

Focused gate notes:

- `extensions/codex/src/app-server/run-attempt.test.ts` was attempted separately for Codex bridge coverage and hung locally with no suite output after starting `vitest.extensions.config.ts`; the hung command was stopped after roughly 90 seconds. Codex conversation-control coverage passed, but full run-attempt bridge coverage remains unproven in this worktree.
- `src/agents/subagent-announce-queue.test.ts` could not be run through `pnpm test` because the current `vitest.agents.config.ts` excludes that exact file and the harness exits with "No test files found." The source carry is still build-covered through `pnpm build` and SDK import coverage.
