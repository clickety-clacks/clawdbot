# Clawline Module Guidelines

Clawline is a first-party local gateway provider that connects devices (iOS, macOS clients) to Clawdbot over WebSocket.

## Clawline to Clawdbot Channel Mapping

Clawline maps to Clawdbot's session/routing model. Understanding this mapping is key:

**Core concept**: SESSION = conversation memory, CHANNEL = delivery pipe.

Conversation continuity comes from the SESSION, not the channel. The channel just determines where replies get delivered.

### Clawline Admin + Personal → Spec Session Keys

Clawline follows the canonical session key spec:

- **Admin channel** uses the main DM session: `agent:main:main`
- **Personal channel** uses per-user Clawline sessions: `agent:main:clawline:{userId}:main`

Admin access is enforced by allowlist `isAdmin`.

### Session Routing Summary

| Clawline | Clawdbot Equivalent | Session Key | Memory |
|----------|---------------------|-------------|--------|
| Admin channel | Main DM session | `agent:main:main` | Shared main |
| Personal channel | Per-user Clawline session | `agent:main:clawline:{userId}:main` | Isolated |

### Comparison with Other Providers

| Source | Session | Reply Goes To |
|--------|---------|---------------|
| Discord DM | `agent:main:main` | That Discord user |
| Telegram DM | `agent:main:main` | That Telegram chat |
| Clawline admin | `agent:main:main` | Admin devices only |
| Clawline personal | `agent:main:clawline:userId:main` | That user's devices |
| Discord `#channel` | `agent:main:discord:channel:id` | That Discord channel |

### Reply Routing

All Clawline channels use the same pattern:
- `OriginatingTo: "user:{userId}"` → `broadcastToUser(userId)` (all user's devices)

## Key Files

- `server.ts` - Main WebSocket server, handles auth, sessions, message routing
- `config.ts` - Allowlist and configuration management
- `domain.ts` - Type definitions for protocol messages
- `outbound.ts` - Outbound message delivery (in extensions/clawline/)

## Important Constants

- `ADMIN_CHANNEL_TYPE = "admin"` - Admin channel type (access control + UI)
- `DEFAULT_CHANNEL_TYPE = "personal"` - Personal channel type

Messages and assets are stored under the real user's ID for both channel types.
The channel type affects session routing and UI separation, not storage.

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
- **Correctness over legacy**: match upstream behavior even if it requires a larger refactor.

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

### Example Applications (Non-Exhaustive)

- **Config/schema alignment**: migrate config to match upstream schema rather than relaxing validators.
- **Isolation**: implement routing/target inference in the channel adapter before touching core tool logic.
- **Prove before change**: confirm with logs/state inspection (allowlist, session store, DB) before editing code.

### Notifications

- Notify at 50% progress and when done (PASS/FAIL).
- If you hit a conflict between preserving Clawline behavior and matching upstream patterns, stop and ask for guidance.

**This procedure applies to every upstream merge/rebase, not just the first one.**
