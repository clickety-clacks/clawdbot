# Clawline Architecture: Why a Separate Provider?

A technical whitepaper on the decision to build Clawline as an independent provider rather than extending the Gateway.

## Thesis

**The Gateway is control-surface-shaped, not chat-shaped.** Extending it to support native chat clients would either compromise its focus on agent orchestration or require speculative abstraction without sufficient evidence of what's truly general. Clawline as a separate provider keeps both systems focused on their respective domains.

---

## Background

### What Is the Gateway?

The Gateway is Clawdbot's orchestration layer. It provides:

- **Agent invocation** (`agent.run`, `chat.send`)
- **Session management** (`sessions.list`, `chat.history`)
- **Health monitoring** (`health`, `channels.status`)
- **Event broadcasting** to connected Control UI clients

Its primary client is the Control UI—a web-based admin console for managing Clawdbot. The Gateway is designed for:

- Ephemeral connections (browser refresh = fresh state)
- Trusted, single-user access (the admin)
- Real-time event streaming without persistence
- Request/response patterns with optional subscriptions

### What Does Clawline Need?

Clawline serves native iOS/macOS chat applications. These clients require:

- **Persistent connections** with per-device state tracking
- **Offline synchronization** (disconnect for hours, reconnect, catch up)
- **Message persistence** with efficient replay by sequence number
- **Device allowlisting** (pairing flow, trust management)
- **Media storage** (upload, download, garbage collection)
- **Delivery acknowledgments** (know which device received which message)

### The Shape Mismatch

| Capability | Gateway | Clawline |
|------------|---------|----------|
| Connection model | Ephemeral | Persistent |
| Storage | None (reads `.jsonl` files) | SQLite with indexed queries |
| Offline clients | Drops events | Queues for replay |
| Auth model | Token-based, trusted | Device allowlisting, untrusted |
| Event delivery | Broadcast to all | Per-device with acks |
| Client state | Stateless | Stateful per device |

These aren't minor differences—they represent fundamentally different architectural assumptions.

---

## The Separate Provider Approach

### Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Control UI    │     │   iOS/macOS     │
│   (Browser)     │     │   (Native App)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │ WebSocket             │ WebSocket
         │ (ephemeral)           │ (persistent)
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│    Gateway      │     │    Clawline     │
│  (port 18789)   │     │  (port 18800)   │
│                 │     │                 │
│ • Agent orchest.│     │ • SQLite store  │
│ • Session mgmt  │     │ • Offline sync  │
│ • Health/status │     │ • Device auth   │
│ • Event stream  │     │ • Media storage │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
                     ▼
         ┌─────────────────────┐
         │   Shared Core       │
         │                     │
         │ • resolveAgentRoute │
         │ • dispatchReply     │
         │ • Session routing   │
         │ • Agent invocation  │
         └─────────────────────┘
```

### What Clawline Implements

1. **WebSocket Server** (~200 LOC)
   - Connection lifecycle management
   - Per-connection state tracking
   - JSON message dispatch

2. **SQLite Database** (~300 LOC)
   - `events` table: All messages with sequence numbers
   - `messages` table: Metadata, acks, device tracking
   - `assets` table: Media file ownership
   - Indexed queries for efficient replay

3. **Offline Sync Protocol** (~150 LOC)
   - Sequence-based event ordering
   - Gap detection and recovery
   - Client reconnection handling

4. **Device Allowlisting** (~200 LOC)
   - Pairing request flow
   - Allowlist/denylist management
   - Per-device identity tracking

5. **Media Handling** (~150 LOC)
   - Asset upload with ownership
   - Secure download with auth
   - Garbage collection

### What Clawline Reuses

Clawline is not a complete reimplementation. It shares:

- **Session routing** (`resolveAgentRoute()`) - Same session key resolution
- **Agent invocation** (`dispatchReplyFromConfig()`) - Same agent execution path
- **Channel plugin system** - Registers as a standard channel
- **Transcript format** - Uses `.jsonl` session files

The separation is at the client-facing edge, not the agent-facing core.

---

## The Gateway Integration Alternative

### Hypothetical: Gateway with Plugin System

If we wanted Gateway to support native chat clients generally:

```typescript
interface GatewayProviderPlugin {
  // Storage plugin
  storage: {
    persistMessage(sessionKey: string, message: Message): Promise<void>;
    getMessagesSince(sessionKey: string, seq: number): Promise<Message[]>;
    acknowledgeDelivery(deviceId: string, seq: number): Promise<void>;
  };

  // Sync plugin
  sync: {
    onClientConnect(client: Client): void;
    onClientDisconnect(client: Client): void;
    getClientState(clientId: string): ClientState;
  };

  // Auth plugin
  auth: {
    validateDevice(token: string): Promise<DeviceIdentity | null>;
    isDeviceAllowed(deviceId: string): Promise<boolean>;
  };
}
```

### Implementation Difficulties

**1. Interface Design Without Evidence**

What operations does the storage interface need?
- Simple key-value? Indexed queries? Full-text search? Vector similarity?
- Transactions? Batch operations? Streaming reads?

Without multiple implementations, these questions are answered by guessing. The first "general" interface is almost always shaped by the first customer's specific needs, making it awkward for the second.

**2. Lifecycle Complexity**

Plugins need initialization, health checks, graceful shutdown, error recovery. Gateway would need:

```typescript
// Plugin lifecycle Gateway would need to manage
interface PluginLifecycle {
  initialize(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
  onError(error: Error): ErrorRecoveryAction;
}
```

This is real engineering—not just exposing hooks but managing plugin lifecycles correctly.

**3. Testing Matrix Explosion**

Gateway currently tests against one client model. With plugins:
- Test with SQLite storage + offline sync + device auth
- Test with Postgres storage + real-time sync + token auth
- Test with memory storage + no sync + no auth
- Test plugin initialization failures
- Test plugin runtime errors
- Test plugin version mismatches

**4. Breaking Change Coordination**

When Gateway's plugin interface changes, all plugins must update. When Clawline's internal storage schema changes, only Clawline updates.

**5. The "General" Trap**

Consider the typing indicator. Gateway emits lifecycle events:

```typescript
emitAgentEvent({
  runId,
  stream: "lifecycle",
  data: { phase: "start" }  // or "end"
});
```

A "general" hook might look like:

```typescript
gateway.onRunLifecycle((sessionKey, phase, runId) => {
  // Provider can use this for typing indicators
});
```

But Clawline also wants `messageId` correlation. So the hook becomes:

```typescript
gateway.onRunLifecycle((sessionKey, phase, runId, messageId?) => {
  // Now we're adding Clawline-specific parameters to a "general" API
});
```

This is how general APIs become specific-customer APIs in disguise.

---

## Comparative Analysis

### Code Duplication

| Component | Gateway LOC | Clawline LOC | Truly Duplicate |
|-----------|-------------|--------------|-----------------|
| WebSocket server | ~200 | ~200 | ~150 (patterns similar, not identical) |
| Event routing | ~150 | ~100 | ~80 |
| JSON-RPC dispatch | ~100 | ~80 | ~60 |
| **Total** | | | **~290 LOC** |

The duplication is real but modest. Both systems need WebSocket handling and event routing—the implementations differ in details (ephemeral vs persistent, broadcast vs per-device).

### Maintenance Burden

**Separate Provider:**
- Two systems to understand conceptually
- Changes to shared core affect both
- Each system's internals are independent

**Gateway Plugins:**
- One system with plugin architecture
- Plugin interface is a contract that constrains both sides
- Plugin bugs can affect Gateway stability

### Evolution Independence

**Separate Provider:**
- Clawline can change storage schema without Gateway release
- Clawline can experiment with sync protocols freely
- Gateway can refactor internals without Clawline compatibility concerns

**Gateway Plugins:**
- Storage schema changes may require interface changes
- Sync protocol experiments constrained by interface
- Gateway refactors must preserve plugin contracts

---

## The "What If" Scenarios

### What If Android/Electron Clients Emerge?

**With Separate Provider (Current):**
- Option A: Implement Clawline's WebSocket protocol (iOS protocol becomes standard)
- Option B: Build another provider (more duplication)
- Option C: Extract common patterns then (informed by two real implementations)

**With Gateway Plugins (Hypothetical):**
- New client implements Gateway's plugin interfaces
- Benefits from existing storage/sync/auth plugins
- Constrained by interfaces designed before their needs were known

### What If Clawline's Approach Is Wrong?

**With Separate Provider:**
- Replace Clawline entirely
- Gateway unaffected
- Migration path: deprecate old, build new

**With Gateway Plugins:**
- Must maintain backward compatibility or coordinate migration
- Gateway changes required
- All plugin users affected

---

## Principles Applied

### 1. Avoid Premature Abstraction

> "Duplication is far cheaper than the wrong abstraction." — Sandi Metz

We have one native chat client. Extracting a "general native chat platform" from one example means guessing. The second client will reveal what's actually general.

### 2. Separate Concerns by Rate of Change

Gateway changes when agent orchestration improves. Clawline changes when native chat UX improves. These are different drivers with different timelines. Coupling them creates coordination overhead.

### 3. Keep Systems Focused

A system that does one thing well is easier to understand, test, and maintain than a system that does two things adequately. Gateway excels at orchestration. Clawline excels at native chat. Neither compromises for the other.

### 4. Design for Replacement, Not Extension

Clawline can be replaced entirely if a better approach emerges. Gateway plugins create lock-in through interface contracts.

---

## Conclusion

The decision to build Clawline as a separate provider reflects a judgment about system boundaries:

**The Gateway is control-surface-shaped.** It answers questions like "run this agent," "show me sessions," "what's the system health?" Its clients are admin consoles and orchestration tools.

**Clawline is chat-shaped.** It answers questions like "sync my messages," "did my device receive this?," "let me upload this image." Its clients are end-user chat applications.

These are different domains with different requirements. Combining them would either:
- Compromise Gateway's simplicity for capabilities only chat clients use
- Create speculative abstractions based on one customer's needs

The ~290 lines of duplicated patterns are an acceptable cost for:
- Clear system boundaries
- Independent evolution
- Freedom to be wrong and recover

If future chat clients emerge, we'll have evidence to inform proper abstractions. Until then, Clawline stands alone—focused, replaceable, and unconstrained by premature generalization.

---

## Appendix: Decision Checklist

For future architectural decisions of this nature:

1. **Are the domains genuinely different?** (Control surface vs chat: yes)
2. **Do the change drivers differ?** (Orchestration vs UX: yes)
3. **Is there a second customer for the abstraction?** (Not yet)
4. **Is the duplication truly costly?** (~290 LOC: no)
5. **Can the separate system be replaced if wrong?** (Yes)
6. **Would integration require speculative interface design?** (Yes)

If answers skew toward "yes," prefer separation over integration.
