# Clawline Agent Guidelines

Clawline is a WebSocket-based local gateway connecting devices to Clawdbot.

## Channel Mapping

Clawline channels map to Clawdbot's session model:

| Clawline | Clawdbot | Session Key | Reply Mechanism |
|----------|----------|-------------|-----------------|
| Admin channel | Main session | `agent:main:main` | `broadcastToAdmins()` |
| Personal channel | Per-user session | `agent:main:clawline:dm:{userId}` | `broadcastToUser(userId)` |

### Admin Channel

- Maps to Clawdbot's **main session** (same as Discord/Telegram DMs with `dmScope: "main"`)
- Only `isAdmin: true` allowlist users can access
- Uses `ADMIN_TRANSCRIPT_USER_ID` (`__clawline_admin__`) for reply routing
- Provides conversation continuity with other providers (Discord DM, Telegram DM, etc.)

### Personal Channels

- Each registered user gets isolated conversation (like Clawdbot groups)
- Uses user's `userId` from allowlist for routing
- Admin users also have a personal channel separate from admin channel

## Key Constants

```typescript
ADMIN_TRANSCRIPT_USER_ID = "__clawline_admin__"
ADMIN_CHANNEL_TYPE = "admin"
DEFAULT_CHANNEL_TYPE = "personal"
```

## Files

- `server.ts` - WebSocket server, auth, sessions, routing
- `config.ts` - Allowlist management
- `domain.ts` - Protocol types
- `extensions/clawline/src/outbound.ts` - Outbound delivery

---

## Upstream Merge Protocol

When merging upstream clawdbot changes:

### Principles

1. **Minimize divergence** - diff vs upstream should be small and justified
2. **Prefer upstream patterns** - use current extension/integration model
3. **Don't invent core hooks** without explicit approval
4. **Adapt, don't force** - if upstream's model changed, adapt Clawline to it

### Process

1. Merge upstream, inventory the diff
2. Restore files unrelated to Clawline
3. Touch only minimal core files required by upstream's integration model
4. If upstream's model changed, rewrite Clawline to match
5. Validate with build/tests

### Minimal Core Touches Allowed

- Config schema/types for provider
- Catalog/registry listing for onboarding
- Plugin-SDK exports used by extensions

### Notifications

- Notify at 50% progress and when done (PASS/FAIL)
- If conflict between Clawline behavior and upstream patterns, stop and ask

**Applies to every upstream merge, not just the first.**
