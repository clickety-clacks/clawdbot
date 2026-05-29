# Clawline Kernel Conformance Implementation Notes

Branch: `clawline-kernel-conformance-v2026_5_27`

## SDK Seam Review

### `openclaw/plugin-sdk/channel-inbound`

Exports used by Clawline:

- `buildChannelInboundEventContext`
- `runChannelInboundEvent`
- `InboundMediaFacts`
- `SupplementalContextFacts`
- `BuiltChannelInboundEventContext`
- `PreparedInboundReply`

Clawline consumers:

- `extensions/clawline/src/runtime/inbound-context.ts`
- `extensions/clawline/src/runtime/server.ts`

Generic provider/channel use case:

- A provider with its own edge protocol can normalize inbound message facts into canonical OpenClaw context.
- A provider with its own delivery/replay surface can still run admitted agent turns through the shared channel lifecycle.

Why existing older SDK surface was insufficient:

- `finalizeInboundContext` only finalized a manually assembled context object.
- Clawline needed the current channel context builder and channel-turn lifecycle wrapper without importing private `src/**` internals.

Compatibility/stability contract:

- These exports are provider/channel SDK seams, not Clawline-specific hooks.
- Clawline supplies provider-edge ACK, local persistence, replay, and socket delivery; the SDK surface owns canonical context shape and channel turn lifecycle stages.

Boundary proof:

- `pnpm lint:extensions:no-src-outside-plugin-sdk` passes with no production extension private-core imports.

## Local Proof Gates

Passed locally:

- `pnpm tsgo:extensions`
- `pnpm tsgo:extensions:test`
- `pnpm exec vitest run extensions/clawline/src/runtime/server.test.ts extensions/clawline/src/runtime/prompt-turn-state.test.ts`
- `pnpm lint:extensions:no-src-outside-plugin-sdk`
- `pnpm build`

Added coverage:

- Normal prompts and generic interactive callback agent turns share prompt admission ordering.
- Same-stream active prompt causes later generic callback turn to remain queued until the active prompt completes.
- First unblocked same-stream prompt transitions to `running`; later blocked same-stream prompt transitions to `queued`.

## Remaining Runtime Proof

Production runtime proof is still required before any production deploy claim:

- quick Clawline ACK
- delivered model response
- second prompt ACK during long turn
- duplicate retry without second model turn
- visible post-ACK failed bubble
- queued same-stream prompt then run
- queued and active cancel behavior
- partial delivery followed by final failure
- restart/reconnect no indefinite spinner
- kernel lifecycle logs
- no duplicate session recording
- no replay or visible-ID regression
