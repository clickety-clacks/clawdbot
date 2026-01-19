# Rebasing Clawdbot Fork

This document describes how to rebase our Clawdbot fork (with Clawline) onto upstream.

## Principles

Your job is to preserve Clawline behavior while aligning to upstream's CURRENT patterns (even if they changed since last time). Avoid reintroducing legacy patterns just to "make it work." If upstream's model changed, adapt Clawline to that model.

- **Minimize divergence**: after the merge, the diff vs upstream should be as small as possible and clearly justified.
- **Prefer upstream patterns**: use whatever extension/integration model upstream uses now.
- **Avoid inventing new core hooks or architecture** unless explicitly approved.

## Process (use as guardrails, not rigid steps)

1. Merge upstream and then inventory the diff vs upstream.
2. Restore any files that are unrelated to Clawline unless there is a clear, justified dependency.
3. Ensure Clawline touches only the smallest set of core files required by upstream's current integration model.
4. If upstream's integration model changed, rewrite Clawline to match it.
5. Validate with build/tests if possible; explain any gaps.

## Examples of "minimal core touches"

Only touch core files if upstream still uses similar patterns:

- A config schema/types entry for a new provider.
- A catalog/registry listing used by onboarding.
- Minimal plugin‑SDK exports used by extensions.

## Notifications

- Notify at 50% progress and when done (PASS/FAIL).
- If you hit a conflict between preserving Clawline behavior and matching upstream patterns, stop and ask for guidance.

**This procedure applies to every upstream merge/rebase, not just the first one.**
