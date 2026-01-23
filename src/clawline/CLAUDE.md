# Clawline Module Guidelines

Clawline is a first-party local gateway provider that connects devices (iOS, macOS clients) to Clawdbot over WebSocket.

## Clawline to Clawdbot Channel Mapping

Clawline maps to Clawdbot's session/routing model as follows:

### Admin Channel → Main Session

The Clawline **admin channel** maps to Clawdbot's **main session** (`agent:main:main`).

- This is the admin's direct line to the agent, shared across all providers
- Same conversation whether you DM via Discord, Telegram, or Clawline admin channel
- Only users marked `isAdmin: true` in the allowlist can access this channel
- Replies broadcast to all connected admin sessions via `broadcastToAdmins()`
- Uses `ADMIN_TRANSCRIPT_USER_ID` (`__clawline_admin__`) as the synthetic user ID for routing

This matches Clawdbot's default `dmScope: "main"` behavior where all DMs share a single conversation.

### Personal Channels → Per-User Sessions

Non-admin users get **personal channels** that map to Clawdbot's **per-user sessions**.

- Each registered user (family member, etc.) gets their own isolated conversation
- Similar to how Telegram/Discord groups get isolated sessions (`agent:main:clawline:dm:userId`)
- The admin also has a personal channel separate from the admin channel
- Routing uses the user's `userId` from the allowlist

### Session Routing Summary

| Clawline Concept | Clawdbot Concept | Session Key Pattern |
|------------------|------------------|---------------------|
| Admin channel | Main session (DM) | `agent:main:main` |
| Personal channel | Per-user session | `agent:main:clawline:dm:{userId}` |

### Reply Routing

- **Admin channel**: `OriginatingTo: "__clawline_admin__"` → `broadcastToAdmins()`
- **Personal channel**: `OriginatingTo: "{userId}"` → `broadcastToUser(userId)`

Both broadcast to all connected devices for that user/admin group, which is consistent with Clawline's multi-device model.

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
