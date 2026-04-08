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

### 2. Choose a destination and ensure tmux session exists there

Every new terminal bubble must carry an explicit destination address. In the current routing model this is an SSH target string such as `mike@eezo` or `eezo`.

The `terminalSessionId` in the descriptor must match a tmux session name on that destination host.

**Use an existing session:**

```bash
ssh <destination-address> tmux list-sessions | grep <session-name>
```

**Or create one:**

```bash
ssh <destination-address> tmux new-session -d -s <session-name> -c /Users/mike 'zsh'
```

Keep names short, lowercase, hyphenated. Examples: `clu-term-test`, `gateway-logs`, `debug-shell`.

### 3. Construct and send the descriptor

Build the JSON descriptor, base64 encode it, and send via `message sendAttachment`.

**Descriptor format:**

```json
{
  "version": 2,
  "terminalSessionId": "<tmux-session-name>",
  "title": "<human-readable title>",
  "destination": {
    "address": "<destination-address>"
  },
  "provider": {
    "baseUrl": "http://TARS.local:18800",
    "wsPath": "/ws/terminal"
  },
  "capabilities": {
    "interactive": true,
    "supportsBinaryFrames": true,
    "supportsResize": true,
    "supportsDetach": true
  },
  "auth": {
    "mode": "chat_token"
  }
}
```

**Required fields:** `version` (always `2`), `terminalSessionId`, `destination.address`
**Strongly recommended:** `provider.baseUrl` (without it, client falls back to stored pairing URL which may be empty)
**Title rule:** `title` is presentation only. It may match the destination, but routing authority is `destination.address`.

**Base64 encode:**

```bash
echo '<json>' | base64 | tr -d '\n'
```

**Send:**

```
message(action=sendAttachment, channel=clawline, target=<stream>, mimeType=application/vnd.clawline.terminal-session+json, filename=terminal-session.json, buffer=<base64>)
```

### 4. Verify

After sending, ask Flynn what they see. Expected: a chromeless terminal bubble with live shell content. If empty/collapsed, check:

- tmux session exists on the exact destination host named in `destination.address`
- Provider baseUrl is correct and reachable from device
- Stream session key is a valid per-user Clawline key

## Quick reference

| Field              | Value                                            |
| ------------------ | ------------------------------------------------ |
| MIME type          | `application/vnd.clawline.terminal-session+json` |
| Provider URL       | `http://TARS.local:18800`                        |
| WS path            | `/ws/terminal`                                   |
| Auth mode          | `chat_token`                                     |
| Descriptor version | `2`                                              |
| Routing authority  | `destination.address`                            |
| tmux location      | Host named by `destination.address`              |

## Common patterns

**Debug shell for Flynn:**
Create a fresh tmux session and send it. Good for showing live logs, running commands, or debugging.

**Attach to existing agent session:**
If a tmux agent session exists on a destination host, send a bubble pointing at it. Flynn can watch the agent work in real time.

**Tail logs:**
Create a tmux session running `tail -f <logfile>`, send as bubble. Live log viewer in chat.

## Routing model

The provider now routes terminal bubbles per bubble, not per process. For a version 2 descriptor with `destination.address`, the provider SSHes to that address for that bubble. The provider-global `terminal.tmux.ssh.target` remains only as compatibility fallback for old version 1 bubbles that lack destination metadata.

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
