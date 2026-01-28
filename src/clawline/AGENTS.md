# Clawline Agent Guidelines

Clawline is a WebSocket-based local gateway connecting devices to Clawdbot.

## Channel Mapping

**Core concept**: SESSION = conversation memory, CHANNEL = delivery pipe.

Clawline synthesizes channel-specific peer IDs so admin/personal behave like Discord channels.

| Clawline | Clawdbot Equivalent | Session Key | Reply Goes To |
|----------|---------------------|-------------|---------------|
| Admin channel | Discord channel-like DM | `agent:main:clawline:dm:{userId}-admin` | User's devices |
| Personal channel | Discord channel-like DM | `agent:main:clawline:dm:{userId}-personal` | User's devices |

### Admin Channel (Per-Channel Session)

- Only `isAdmin: true` allowlist users can access
- Conversation is isolated from the personal channel
- Replies go to that user's devices (admin-only gated)

### Personal Channels (Per-User Sessions)

- Each registered user gets isolated conversation
- Admin users also have personal channel access

## Key Constants

```typescript
ADMIN_CHANNEL_TYPE = "admin"  // admin-only channel (access control + UI)
DEFAULT_CHANNEL_TYPE = "personal"  // personal channel
```

Messages and assets are stored under the real user's ID for all channel types.
Channel type only affects session routing and UI separation.

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
5. **Correctness over legacy** - match upstream behavior even if it requires a larger refactor

### Example Applications (Non-Exhaustive)

- **Config/schema alignment**: migrate config to match upstream schema rather than relaxing validators.
- **Isolation**: implement routing/target inference in the channel adapter before touching core tool logic.
- **Prove before change**: confirm with logs/state inspection (allowlist, session store, DB) before editing code.

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
