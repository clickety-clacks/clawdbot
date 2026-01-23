# Clawline Module Guidelines

Clawline is a first-party local gateway provider that connects devices (iOS, macOS clients) to Clawdbot over WebSocket.

## Clawline to Clawdbot Channel Mapping

Clawline maps to Clawdbot's session/routing model. Understanding this mapping is key:

**Core concept**: SESSION = conversation memory, CHANNEL = delivery pipe.

Conversation continuity comes from the SESSION, not the channel. The channel just determines where replies get delivered.

### Clawline DM → Main Session

The Clawline **DM channel** (accessed by `isAdmin: true` users) maps to Clawdbot's **main session** (`agent:main:main`).

- Equivalent to DMing the Discord bot or Telegram bot
- Same conversation memory whether you DM via Discord, Telegram, or Clawline
- Only `isAdmin: true` allowlist users can access this channel
- Replies go back to the originating user (all their devices), NOT broadcast to all admins
- Continuity comes from the shared session, not from broadcasting

This matches Clawdbot's default `dmScope: "main"` behavior where all DMs share conversation context.

### Personal Channels → Per-User Sessions

Non-admin users get **personal channels** that map to isolated **per-user sessions**.

- Each registered user (family member, etc.) gets their own isolated conversation
- Similar to Discord channels - each has separate memory (`agent:main:clawline:dm:{userId}`)
- Admin users also have access to personal channels (separate from the DM channel)
- Agent doesn't mix conversations between users

### Session Routing Summary

| Clawline | Clawdbot Equivalent | Session Key | Memory |
|----------|---------------------|-------------|--------|
| DM channel | Discord/Telegram DM | `agent:main:main` | Shared (main) |
| Personal channel | Discord channel | `agent:main:clawline:dm:{userId}` | Isolated |

### Comparison with Other Providers

| Source | Session | Reply Goes To |
|--------|---------|---------------|
| Discord DM | `agent:main:main` | That Discord user |
| Telegram DM | `agent:main:main` | That Telegram chat |
| Clawline DM | `agent:main:main` | That Clawline user's devices |
| Discord `#channel` | `agent:main:discord:channel:id` | That Discord channel |
| Clawline personal | `agent:main:clawline:dm:userId` | That user's devices |

### Reply Routing

All channels use the same pattern:
- `OriginatingTo: "{userId}"` → `broadcastToUser(userId)` (all user's devices)

No special handling for DM channel - it works like any other channel, just routes to main session.

## Key Files

- `server.ts` - Main WebSocket server, handles auth, sessions, message routing
- `config.ts` - Allowlist and configuration management
- `domain.ts` - Type definitions for protocol messages
- `outbound.ts` - Outbound message delivery (in extensions/clawline/)

## Important Constants

- `ADMIN_TRANSCRIPT_USER_ID = "__clawline_admin__"` - Synthetic user ID for admin channel
- `ADMIN_CHANNEL_TYPE = "admin"` - Channel type marker
- `DEFAULT_CHANNEL_TYPE = "personal"` - Default channel for regular users

---

## Upstream Merge Protocol

When merging or rebasing upstream clawdbot changes into our fork:

**Why this matters:** Blind merging causes problems:
- Reintroducing deprecated clawdbot features just to make clawline compile
- Missing new patterns we should adopt (better extension points, refactored infra)
- Duplicating functionality that upstream now provides differently
- Coupling clawline too tightly to internals that will change

### Rebase Principles

Preserve Clawline behavior while aligning to upstream's CURRENT patterns (even if they changed). Avoid reintroducing legacy patterns just to "make it work." If upstream's model changed, adapt Clawline to that model.

- **Minimize divergence**: after the merge, the diff vs upstream should be as small as possible and clearly justified.
- **Prefer upstream patterns**: use whatever extension/integration model upstream uses now.
- **Avoid inventing new core hooks or architecture** unless explicitly approved.

### Process

1. Merge upstream and then inventory the diff vs upstream.
2. Restore any files that are unrelated to Clawline unless there is a clear, justified dependency.
3. Ensure Clawline touches only the smallest set of core files required by upstream's current integration model.
4. If upstream's integration model changed, rewrite Clawline to match it.
5. Validate with build/tests if possible; explain any gaps.

### Minimal Core Touches

Only touch core files if upstream still uses similar patterns:

- A config schema/types entry for a new provider.
- A catalog/registry listing used by onboarding.
- Minimal plugin-SDK exports used by extensions.

### Notifications

- Notify at 50% progress and when done (PASS/FAIL).
- If you hit a conflict between preserving Clawline behavior and matching upstream patterns, stop and ask for guidance.

**This procedure applies to every upstream merge/rebase, not just the first one.**
