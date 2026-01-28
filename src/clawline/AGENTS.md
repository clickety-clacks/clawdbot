# Clawline Agent Guidelines

Clawline is a WebSocket-based local gateway connecting devices to Clawdbot.

## Channel Mapping

**Core concept**: SESSION = conversation memory, CHANNEL = delivery pipe.

Clawline follows the canonical session key spec:

| Clawline | Clawdbot Equivalent | Session Key | Reply Goes To |
|----------|---------------------|-------------|---------------|
| Admin channel | Main DM session | `agent:main:main` | Admin devices only |
| Personal channel | Per-user Clawline session | `agent:main:clawline:{userId}:main` | User's devices |

### Admin Channel (Main Session)

- Only `isAdmin: true` allowlist users can access
- Conversation uses the shared main session (`agent:main:main`)
- Replies go to admin devices only (admin-only gated)

### Personal Channels (Per-User Sessions)

- Each registered user gets isolated conversation via `agent:main:clawline:{userId}:main`
- Admin users also have personal channel access (separate from main)

## Key Constants

```typescript
ADMIN_CHANNEL_TYPE = "admin"  // admin-only channel (access control + UI)
DEFAULT_CHANNEL_TYPE = "personal"  // personal channel
```

Messages and assets are stored under the real user's ID for all channel types.
Channel type only affects session routing and UI separation.

## Experimental Hooks

### Face speak (outbound)

If `CLU_FACE_SPEAK_URL` is set, the provider POSTs `{"text":"..."}` after successful outbound sends.
This is best-effort (non-blocking, errors swallowed). Empty text is skipped; long text is capped.

Example (local only):
```bash
export CLU_FACE_SPEAK_URL="http://127.0.0.1:9001/speak"
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
