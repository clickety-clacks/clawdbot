# Upstream Merge Protocol (Clawline)

**When:** Merging or rebasing upstream clawdbot/openclaw changes into our fork.

**Why:** Blind merging causes problems:

- Reintroducing deprecated clawdbot features just to make clawline compile
- Missing new patterns we should adopt (better extension points, refactored infra)
- Duplicating functionality that upstream now provides differently
- Coupling clawline too tightly to internals that will change

## Rebase Principles

Your job is to preserve Clawline behavior while aligning to upstream's CURRENT patterns (even if they changed since last time). Avoid reintroducing legacy patterns just to "make it work." If upstream's model changed, adapt Clawline to that model.

- **Minimize divergence**: after the merge, the diff vs upstream should be as small as possible and clearly justified.
- **Prefer upstream patterns**: use whatever extension/integration model upstream uses now.
- **Avoid inventing new core hooks or architecture** unless explicitly approved.

## Process (use as guardrails, not rigid steps)

0. **Create a worktree** for the rebase work — upstream merges are risky and need isolation.
1. Merge upstream and then inventory the diff vs upstream.
2. Restore any files that are unrelated to Clawline unless there is a clear, justified dependency.
3. Ensure Clawline touches only the smallest set of core files required by upstream's current integration model.
4. If upstream's integration model changed, rewrite Clawline to match it.
5. Validate with build/tests if possible; explain any gaps.

## Minimal Core Touches

Only touch core files if upstream still uses similar patterns:

- A config schema/types entry for a new provider.
- A catalog/registry listing used by onboarding.
- Minimal plugin-SDK exports used by extensions.

## Conflict Rule

If you hit a conflict between preserving Clawline behavior and matching upstream patterns, STOP and notify. Do not guess.

## Restore Rule

After merge, check for files unrelated to Clawline that got modified. Restore those to upstream state — our fork should only diverge where Clawline requires it.

## Notifications

- Notify at major milestones, blockers, and completion (PASS/FAIL).
- Do NOT push without review approval.
