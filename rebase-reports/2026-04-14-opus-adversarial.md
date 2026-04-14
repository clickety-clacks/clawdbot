# v2026.4.14 Opus Adversarial Review — 2026-04-14

## Result

No blockers.

## Scope

- Compared current `HEAD` against prior approved branch tip `487b56a029`.
- Reviewed the surviving fork-vs-upstream seam with emphasis on:
  - new divergence introduced by the `.14` carry-forward
  - whether the runtime-deps carve-out stayed minimal
  - whether any of the four Plugin SDK helper seams can now be reduced further
  - whether the merge hides any new regression risk

## Opus Verdict

Opus returned:

> No blockers.
>
> The surviving seams are justified:
>
> 1. `scripts/stage-bundled-plugin-runtime-deps.mjs` + test — install-time seam, required for smooth bundled plugin runtime dep staging.
> 2. `dispatchReplyFromConfig` — upstream helpers still do not expose `replyResolver` or direct `queuedFinal`/count results.
> 3. `enqueueAnnounce` — no upstream equivalent surface.
> 4. `resolveAllAgentSessionStoreTargetsSync` — no upstream replacement.
> 5. `loadGatewayTlsRuntime` — no upstream replacement.

Raw Opus output was captured in `scratch/opus-2026-04-14-adversarial.txt`.

## Local Validation Against The Tree

### 1. New divergence introduced by `.14`

- Relative to `487b56a029`, the only substantive code delta is the runtime-deps staging script/test port plus new audit reports.
- The four helper-export seams were already present on the approved `.11` tip and did not widen on this lane.

### 2. Runtime-deps carve-out minimality

- The surviving fork-only behavior versus upstream `v2026.4.14` is still narrow:
  - refuse the root-copy fast path when a runtime dependency needs lifecycle execution (`gypfile` or install script)
  - allow staged install to run lifecycle scripts by dropping `--ignore-scripts`
  - cover that fallback in `test/scripts/stage-bundled-plugin-runtime-deps.test.ts`
- The larger prune-config refactor in `scripts/stage-bundled-plugin-runtime-deps.mjs` came from upstream shape drift during the port, not from a new fork-side requirement.
- Under Flynn's keep-rule, the lifecycle fallback remains justified because smooth install/runtime for native deps like `better-sqlite3` still depends on it.

### 3. Helper seams still required

- `dispatchReplyFromConfig` still cannot be dropped in favor of `src/plugin-sdk/inbound-reply-dispatch.ts`.
  - Clawline currently calls it twice in `extensions/clawline/src/runtime/server.ts`.
  - Both paths rely on `replyResolver` injection and direct return inspection (`queuedFinal`, reply counts).
  - The new upstream helper family wraps dispatch, but it does not expose the same direct result path.
- `enqueueAnnounce` is still directly used for alert queueing in `extensions/clawline/src/runtime/server.ts`, with no narrower public replacement.
- `resolveAllAgentSessionStoreTargetsSync` is still directly used for merged session-store discovery in `extensions/clawline/src/runtime/server.ts`, with no narrower public replacement.
- `loadGatewayTlsRuntime` is still directly used for provider TLS startup in `extensions/clawline/src/runtime/server.ts`, with no narrower public replacement.

### 4. Hidden regression risk

- No new product-level blocker surfaced from the `.14` carry-forward.
- Residual risk remains the same environment-only install concern already seen during verification: native deps can still require rebuild after install before tests pass. That is not a new architectural seam introduced by this review lane.

## Engram Note

- Queried:
  - `engram explain scripts/stage-bundled-plugin-runtime-deps.mjs:103-170`
  - `engram explain src/plugin-sdk/reply-runtime.ts:30-35`
- Result:
  - the staging-script query returned low-confidence, noisy historical matches
  - the helper-export query did not yield anything decision-useful
- Influence on review: none

## Bottom Line

- Nothing in the current `.14` carry-forward should be removed based on this Opus adversarial pass.
- The runtime-deps carve-out still looks minimal.
- None of the four Plugin SDK helper seams can be reduced further on the current upstream surface without behavior loss or duplicating host internals.
