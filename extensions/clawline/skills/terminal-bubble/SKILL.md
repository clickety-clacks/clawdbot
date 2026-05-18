---
name: terminal-bubble
description: Send a live terminal bubble into a Clawline chat stream. The bubble connects to a per-bubble destination via the provider over WebSocket and renders an interactive terminal inside the message flow. Use when Flynn asks to send a terminal, share a live shell, or embed a terminal in chat. Also use when another skill or workflow needs to surface a live terminal session to the user.
---

# Terminal Bubble

Send an interactive terminal bubble to a Clawline stream. The bubble renders a live tmux session inside the chat message flow via SwiftTerm + WebSocket.

## Prerequisites

- Clawline provider running on TARS (port 18800)
- A tmux session on the destination host (created or existing)
- Target stream must be a per-user Clawline session (`:main`, `:dm`, or custom `s_*`)

## Procedure

### 1. Determine target stream

Default to the **current session's stream**. Extract the stream suffix from the session key:

```
agent:main:clawline:flynn:s_417c16a8  →  target = "flynn:s_417c16a8"
agent:main:clawline:flynn:main        →  target = "flynn:main"
```

If Flynn specifies a different stream, use that.

### 2. Choose a destination

Every new terminal bubble must carry an explicit destination address. In the current routing model this is an SSH target string such as `mike@eezo` or `eezo`.

You do not need to hand-author a descriptor. Omit `terminalSession.name` for a destination login shell, or provide it when attaching or creating a named tmux session on the destination.

### 3. Send the terminal-bubble request

Send a structured `message sendAttachment` request with terminal mime type plus `destination.address`.

**Request shape:**

```json
{
  "target": "<stream>",
  "mimeType": "application/vnd.clawline.terminal-session+json",
  "title": "<human-readable title>",
  "terminalSession": {
    "name": "<optional-existing-tmux-session-name>"
  },
  "destination": {
    "address": "<destination-address>"
  }
}
```

**Required fields:** `mimeType`, `target`, `destination.address`
**Title rule:** `title` is presentation only. It may match the destination, but routing authority is `destination.address`.
**Session rule:** `terminalSession.name` is optional. When supplied, it is the caller-facing tmux session name to attach or create on the destination host. When omitted, the provider connects to `destination.address` and leaves the user in the destination login shell; it does not generate a tmux session name. `terminalSessionId` is an opaque descriptor/auth id; `tmuxSessionName` and top-level `terminalSessionId` are compatibility aliases for request input only and must match `terminalSession.name` when supplied together.

**Send:**

```
message(action=sendAttachment, channel=clawline, target=<stream>, mimeType=application/vnd.clawline.terminal-session+json, destination={"address":"<destination-address>"}, terminalSession={"name":"<optional-existing-tmux-session-name>"}, title="<optional title>")
```

The provider emits a version 3 descriptor attachment. The descriptor always has an opaque `terminalSessionId` for auth/lookup. The tmux identity lives in `terminalSession.name` when supplied and defaults to `attach_or_create`; unnamed requests have no tmux identity.

### 4. Verify

After sending, ask Flynn what they see. Expected: a chromeless terminal bubble with live shell content. If empty/collapsed, check:

- the destination host in `destination.address` is reachable from the provider
- Provider baseUrl is correct and reachable from device
- Stream session key is a valid per-user Clawline key

## Quick reference

| Field              | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| MIME type          | `application/vnd.clawline.terminal-session+json`                                    |
| WS path            | `/ws/terminal`                                                                      |
| Auth mode          | `chat_token`                                                                        |
| Descriptor version | provider-generated `3`                                                              |
| Routing authority  | `destination.address`                                                               |
| tmux session name  | optional caller-supplied `terminalSession.name`; unnamed requests use a login shell |
| tmux location      | Host named by `destination.address`                                                 |

## Common patterns

**Debug shell for Flynn:**
Send a destination-aware request without `terminalSession.name`. The provider connects to the destination login shell. Good for ad hoc debugging when a durable tmux session is not required.

**Attach to existing agent session:**
Send a destination-aware request with `terminalSession.name` set to the existing tmux session name on that destination host.

**Tail logs:**
Out of scope for this minimal routing slice unless another product surface intentionally writes that command into the created shell.

## Routing model

The provider now routes terminal bubbles per bubble, not per process. For a version 3 descriptor with `destination.address` and no `terminalSession.name`, the provider SSHes to that address and opens a login shell. With `terminalSession.name`, it attaches or creates that named tmux session for that bubble. The provider-global `terminal.tmux.ssh.target` remains only as a visibly legacy/unknown compatibility fallback for old version 1 bubbles that lack destination metadata.

Provider SSH config still supplies shared connection defaults such as identity file and host-key settings:

```json
{
  "terminal": {
    "tmux": {
      "ssh": {
        "identityFile": "/Users/mike/.ssh/id_ed25519_clu"
      }
    }
  }
}
```

Do not rely on the provider-global ssh target to choose the destination for a new bubble.

## Known limitations

- **30-second offscreen teardown:** If the bubble scrolls off-screen for 30+ seconds, the terminal disconnects and requires manual reconnect tap.
- **Terminal history not preserved** across cell reuse/recreation in the chat scroll.
- **Error UX is generic:** Many failure modes collapse into a disconnected overlay.
