# Clawline Kernel Conformance Phase 2 Executive Report

Branch: `clawline-kernel-conformance-v2026_5_27`
Reviewed HEAD: `fc18beab44ee7dcf327d93265a7b65e5a843ff07`
Spec: `/Users/mike/shared-workspace/clawline/specs/clawline-openclaw-kernel-conformance-migration.md`

## Executive Verdict

Phase 2 is primarily a conformance review/respond track, not a second large
implementation wave. The current branch has adopted the upstream patterns that
directly affect Phase 1 prompt reliability: canonical inbound context building,
shared media/reply facts, public SDK channel-turn seams, prompt/control/local
lane separation, and removal of production private-core imports.

No additional Phase 2 code change is recommended before runtime proof. The next
highest-value work is to deploy/smoke this branch against real Clawline sessions,
including at least one pathological large-session fixture, and use those results
to decide whether any remaining provider-owned Clawline mechanism is actually
malignant.

## Provider Pattern Parity

| Clawline area            | Upstream exemplar                                        |                        Match? | Decision                     | Evidence                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------- | ----------------------------: | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound prompt lifecycle | `src/channels/turn/kernel.ts` / `runChannelInboundEvent` | Yes for admitted prompt turns | Adopted                      | Clawline calls `runChannelInboundEvent` in `extensions/clawline/src/runtime/server.ts:5225`; upstream kernel owns ingest/classify/preflight/resolve/finalize at `src/channels/turn/kernel.ts:600`.                                                                         |
| Context construction     | `buildChannelInboundEventContext`                        |                           Yes | Adopted                      | Clawline imports public SDK builder in `extensions/clawline/src/runtime/inbound-context.ts:1` and calls it at `extensions/clawline/src/runtime/inbound-context.ts:168`; SDK export is `src/plugin-sdk/channel-inbound.ts:80`.                                              |
| Media facts              | `buildChannelInboundMediaPayload` / `InboundMediaFacts`  |             Partial by design | Keep edge plus adopted facts | Clawline keeps asset ownership/materialization, then passes `media` facts into the builder at `extensions/clawline/src/runtime/server.ts:10259` and `extensions/clawline/src/runtime/inbound-context.ts:162`; SDK media export is `src/plugin-sdk/channel-inbound.ts:153`. |
| Reply/reference facts    | Canonical `ReplyToId*` and supplemental quote            |             Partial by design | Keep edge plus adopted facts | Clawline still resolves iOS-visible IDs locally, then maps canonical quote/reply fields in `extensions/clawline/src/runtime/inbound-context.ts:99`; tests assert `ReplyToId`/`ReplyToIdFull` in `extensions/clawline/src/runtime/inbound-context.test.ts:74`.              |
| Delivery/replay          | No upstream Clawline client delivery abstraction         |          No direct equivalent | Keep edge                    | Spec explicitly keeps ACK/error frames, reconnect replay, local streaming state, bubble persistence, and socket fanout in Clawline; implementation persists/broadcasts assistant delivery in `extensions/clawline/src/runtime/server.ts:10158`.                            |
| Queueing                 | Shared channel turn kernel plus keyed async queues       |      Match on lock-scope goal | Adopted for Phase 1          | Admission queue releases before model dispatch at `extensions/clawline/src/runtime/server.ts:9883` and turn dispatch runs separately at `extensions/clawline/src/runtime/server.ts:10293`; lane queues are in `extensions/clawline/src/runtime/per-user-task-queue.ts:69`. |
| Interactive callbacks    | Prompt-turn lane when callback triggers agent work       |                           Yes | Adopted                      | Generic callback agent turns now use prompt admission ordering in `extensions/clawline/src/runtime/server.ts:10442`; coverage is in `extensions/clawline/src/runtime/server.test.ts:7403`.                                                                                 |
| Private core imports     | Public `openclaw/plugin-sdk/**` seams                    |             Yes in production | Adopted                      | Production Clawline imports are plugin SDK or local runtime API; private `../../../../src/**` hits are tests only. `pnpm lint:extensions:no-src-outside-plugin-sdk` passes.                                                                                                |

## Clawline Mechanisms Revalidated

| Mechanism                         | Product behavior preserved                                                        | Upstream replacement checked                                                                | Decision                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Local SQLite message/event state  | Durable ACK/replay, visible bubbles, reconnect recovery                           | Channel kernel does not own Clawline socket replay or iOS event persistence                 | Keep edge.                                                                            |
| Client ACK/error frame contract   | Fast visible acceptance and concrete post-ACK failures                            | Kernel lifecycle stages are internal; they do not define Clawline wire protocol             | Keep edge.                                                                            |
| Visible-ID reference resolver     | Lets iOS reply to user/assistant bubbles using Clawline-visible IDs               | Upstream has canonical reply fields but no Clawline visible-ID resolver                     | Keep edge, feed canonical fields.                                                     |
| Asset ownership/materialization   | Keeps upload/download auth, asset IDs, inline base64, outbound media optimization | Upstream media helpers normalize facts, not Clawline asset storage                          | Keep edge, feed media facts.                                                          |
| Prompt-turn admission facts/state | Prevents indefinite accepted/running spinners after ACK                           | Upstream kernel does not reconstruct Clawline-local accepted prompts after provider restart | Keep edge for now; reconsider only if upstream grows durable channel delivery/replay. |
| Lane split                        | Prevents long model/tool/compaction turns from blocking ACK/control/local work    | Upstream kernel handles turn lifecycle, not provider ingress policy                         | Adopted as provider-owned policy.                                                     |

## Recommendations

1. **Do not add Phase 2 implementation before runtime proof.** The remaining
   Phase 2 questions are not currently code blockers. Additional refactor now
   risks architecture churn without proving the reliability goal.

2. **Run the runtime proof next on shrdlu before TARS.** The code review says
   Phase 1 is code-complete, but the spec still requires product-path proof:
   quick ACK, delivered response, second prompt ACK during long turn, duplicate
   retry, visible failed bubble, queued same-stream prompt, cancel behavior,
   restart/reconnect recovery, and channel-turn lifecycle logs.

3. **Seed shrdlu with pathological large-session fixtures.** Copy representative
   long-session content into test-only shrdlu sessions rather than overwriting
   live sessions. This is the right way to prove the branch handles the pressure
   classes that made TARS unreliable.

4. **Keep Clawline delivery/replay provider-owned for now.** Upstream does not
   currently expose a Clawline-equivalent delivery/replay abstraction. Moving it
   into core would increase divergence and does not directly solve prompt
   reliability.

5. **Treat future Phase 2 work as an audit queue.** For each carried Clawline
   mechanism, keep using the spec's classification: `adopt now`, `keep edge`,
   `needs seam`, or `blocked`. Only implement `adopt now` or `needs seam` items
   when there is a concrete product/reliability payoff or merge-drift reduction.

## Decision Points For Flynn

- Approve shrdlu runtime proof with seeded pathological sessions.
- Decide whether runtime proof must include iOS simulator/client reply flows
  before TARS deploy, or whether host/provider proof is enough for a first soak.
- Decide whether to track full Phase 2 as a standing conformance audit rather
  than a single implementation milestone.
