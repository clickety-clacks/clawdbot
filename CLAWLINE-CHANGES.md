# Clawline Fork — Changes to Preserve in Upstream Rebase

This document lists every functional change our fork has made relative to upstream
(`openclaw/openclaw`). During a rebase, ALL of these must survive — even if they need
to be rewritten to conform to new upstream patterns. Do NOT let upstream overwrite them.

If you are unsure how to preserve any of these without breaking upstream's new patterns,
**STOP and ask CLU** before proceeding. Do not guess and do not silently drop functionality.

---

## 1. Clawline Extension (the whole thing)

`src/clawline/` and `extensions/clawline/` are entirely ours — upstream has no equivalent.
These files must be preserved wholesale. Conflicts here are always resolved in our favor
unless the upstream change is to a shared interface (in which case: stop and ask CLU).

Key subsystems inside the extension:

### 1a. Session & Alert Routing

- Session key routing: all outbound messages route via `sessionKey`, not channel name
- Alert endpoint (`/alert`) accepts any non-empty session key (relaxed from strict format)
- Alert responses route to the correct CLU stream (admin vs. personal) without bleeding
- Session binding preserved across reconnect/reset
- Session files kept in agent sessions dir (not root)

### 1b. Multi-Stream Architecture (Phase A)

- Multiple simultaneous Clawline streams (e.g. "Engram", "Dictation", "Markdown")
- Each stream = its own session key, routed independently
- `clawline: parallelize ingress across stream session keys` — commit `f4864eaf`
  - Introduced `per-user-task-queue.ts`: per-user queue, but streams run in parallel
  - Large refactor of `server.ts` to support this
- DM stream gated by `dmScope` config (`fix(clawline): gate DM stream on dmScope config`)
- Built-in streams seeded with canonical names (`clawline: seed built-in streams`)
- Stream rename/delete mutation key normalization
- Double-encoded stream keys accepted for rename/delete

### 1c. Serialization Guard REMOVED

- `Revert "fix clawline cross-stream run queue serialization"` — commit `238e0f220`
  - A guard in `pi-embedded-runner/run.ts` was serializing ALL agent runs across all streams
  - This was wrong — streams should run independently in parallel
  - The revert removed that guard from `run.ts` and `server.ts`
  - **This must NOT be re-introduced.** If upstream adds similar serialization to `run.ts`,
    check whether it affects cross-stream parallelism before accepting it.

### 1d. Attachment & Media Pipeline

- `sendAttachment` with custom mimeType support
- Outbound document attachments via WebSocket
- Rich attachment delivery unblocked
- Parameterized data URI base64 attachments accepted
- `sendAttachment` terminal delivery path fixed
- Buffer handling for Clawline sendAttachment
- Timeout, result summary, mimeType normalization for sendAttachment
- Asset image attachments included in model context (`fix: include asset image attachments in clawline model context`)
- Attachment-only messages allowed (no text required)
- Inline attachment limits removed

### 1e. Terminal Sessions

- Terminal session WebSocket endpoint
- Terminal session auth via DB lookup
- Hydrate terminal sessions from SQLite on reconnect
- Remote tmux support via SSH
- tmux session started on terminal bubble send
- Terminal bubbles gated by advertised client features (`T068`)

### 1f. Device Management / Pairing

- Pairing flow with pending socket timeout
- Allowlist reload synchronously on pairing
- Denied-device TTL bounded
- `clawline-device-management` skill (approve/deny pending devices)
- Alert instructions config (`clawline: wire alert instructions config`)

### 1g. Web Root / Media

- `/www` hosting at `channels.clawline.webRootPath` (dot-dir allowed)
- Symlink traversal allowed for `/www`
- SSRF hardening for outbound media fetches (local to Clawline — not in upstream core)
- Media URL validation, redirect handling, private IP blocking

### 1h. Inbound Context

- Clawline adapter system prompt wired into inbound context
- Inbound images forwarded to agent
- Trusted metadata envelope in system prompt

### 1i. Auth & Security

- JWT issuer check relaxed for Clawline tokens
- Case-insensitive login (lowercase claimedName)
- Admin gating based on userId, not channel name
- Account switching on same device (with security fixes)
- `isAdmin` set based on userId on account switch

### 1j. Skills

All of these skills are ours and must survive the rebase:

- `extensions/clawline/skills/alert-overlay/`
- `extensions/clawline/skills/device-management/`
- `extensions/clawline/skills/gateway-ops/`
- `extensions/clawline/skills/media/`
- `extensions/clawline/skills/webroot/`
- `clawline-stream-lookup` skill (maps stream names ↔ session keys)
- `clawline-dm` skill (cross-stream DM initiation/reply; stream-lookup consolidated here)

### 1k. Chat IA (3-stream routing)

- `fix: Chat IA handshake - use session key array (N3/N7)`
- `Clawline: implement Chat IA 3-stream routing`

### 1l. Scroll Position (iOS)

- `T036 iOS chat: restore scroll position on relaunch`
- `T036: flush scroll state on background`
  (These have been reverted and re-applied; current state has them applied.)

### 1m. OpenClawKit

- `OpenClawKit: back off WS connect on auth rejection`
  (Reverted and re-applied; current state has it applied.)

---

## 2. Core File Changes (touches files upstream also owns)

These are the highest-risk items — upstream will likely have conflicting changes here.

### 2a. src/config/defaults.ts

- `sonnet` alias → `anthropic/claude-sonnet-4-6`
- `sonnet-4.5` alias → `anthropic/claude-sonnet-4-5`
- `sonnet-4.6` alias → `anthropic/claude-sonnet-4-6`
- These are **additive** — if upstream also updates the sonnet alias, take upstream's value
  for `sonnet` but keep our `sonnet-4.5` and `sonnet-4.6` explicit aliases.

### 2b. src/agents/model-selection.ts — buildAllowedModelSet fix

- Commit `9dbc6e8be`: if a model's provider == the default provider (Anthropic OAuth),
  allow it even if there's no catalog entry and no `models.providers.anthropic` config.
- **Without this fix, `/model sonnet` silently fails for OAuth users.**
- If upstream has changed `buildAllowedModelSet`, integrate this condition carefully.
  Stop and ask CLU if you're not sure how to merge it.

### 2c. package.json / lockfile — pi-ai bump

- We bumped `@mariozechner/pi-ai` from `0.52.8` → `0.53.0`
- This adds `claude-sonnet-4-6` to the built-in model catalog
- **If upstream has also bumped pi-ai**, take their version and lockfile — ours was a
  stopgap. If upstream is still on 0.52.x, keep our bump.

### 2d. src/agents/pi-embedded-runner/run.ts — serialization guard removed

- The revert (`238e0f220`) removed a mutex/serialization that was blocking cross-stream
  parallel runs from `pi-embedded-runner/run.ts`.
- If upstream has modified `run.ts`, check carefully that they haven't re-introduced
  any form of global run serialization. If they have: stop and ask CLU.

---

## 3. Docs / Chores (low risk, keep ours)

- `CHANGELOG.md` — keep both our entries and upstream's; don't drop either
- `REBASE.md` — ours; upstream won't have it
- `docs/` — upstream parity audit, rebase report, etc.
- `chore: update lint/format commands to pnpm check`

---

## Merge Decision Rules

1. **Clawline extension files** → always ours (upstream has none)
2. **Core files with upstream changes** → integrate carefully; preserve our behavior
3. **CHANGELOG.md** → keep all entries from both sides
4. **Uncertainty** → STOP. Notify CLU with exactly what the conflict is.
   Do not guess. Do not drop functionality silently.

---

## How to Notify CLU

```bash
~/.local/libexec/clu/hosts/eezo/notify --session agent:main:clawline:flynn:s_105e446e -- "rebase blocked: <describe the conflict>"
```
