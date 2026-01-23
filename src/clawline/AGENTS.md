# Clawline Agent Guidelines

Clawline is a WebSocket-based local gateway connecting devices to Clawdbot.

## Channel Mapping

**Core concept**: SESSION = conversation memory, CHANNEL = delivery pipe.

| Clawline | Clawdbot Equivalent | Session Key | Reply Goes To |
|----------|---------------------|-------------|---------------|
| DM channel | Discord/Telegram DM | `agent:main:main` | User's devices |
| Personal channel | Discord channel | `agent:main:clawline:dm:{userId}` | User's devices |

### DM Channel (Main Session)

- Maps to Clawdbot's **main session** (same as Discord/Telegram DMs)
- Only `isAdmin: true` allowlist users can access
- Provides conversation continuity with other providers
- Replies go to originating user, not broadcast to all admins
- Continuity comes from shared SESSION, not from broadcasting

### Personal Channels (Per-User Sessions)

- Each registered user gets isolated conversation
- Similar to Discord channels - separate memory per user
- Admin users also have personal channel access

## Key Constants

```typescript
ADMIN_CHANNEL_TYPE = "admin"  // DM channel (routes to main session)
DEFAULT_CHANNEL_TYPE = "personal"  // per-user session
```

Messages and assets are stored under the real user's ID for all channel types.
Channel type only affects session routing (main vs isolated).

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
