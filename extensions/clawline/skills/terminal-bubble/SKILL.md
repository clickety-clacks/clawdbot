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

You do not need to hand-author a descriptor. Omit `terminalSessionId` for a new bubble, or provide it when attaching the bubble to an existing tmux session on the destination.

### 3. Send the terminal-bubble request

Send a structured `message sendAttachment` request with terminal mime type plus `destination.address`.

**Request shape:**

```json
{
  "target": "<stream>",
  "mimeType": "application/vnd.clawline.terminal-session+json",
  "title": "<human-readable title>",
  "terminalSessionId": "<optional-existing-tmux-session-name>",
  "destination": {
    "address": "<destination-address>"
  }
}
```

**Required fields:** `mimeType`, `target`, `destination.address`
**Title rule:** `title` is presentation only. It may match the destination, but routing authority is `destination.address`.
**Session rule:** `terminalSessionId` is optional. When supplied, it identifies the tmux session to attach on the destination host; when omitted, the provider generates a fresh session id.

**Send:**

```
message(action=sendAttachment, channel=clawline, target=<stream>, mimeType=application/vnd.clawline.terminal-session+json, destination={"address":"<destination-address>"}, title="<optional title>")
```

The provider emits the version 2 descriptor attachment. When `terminalSessionId` is omitted, it generates a fresh id; when supplied, the descriptor uses that caller-supplied tmux session identity.

### 4. Verify

After sending, ask Flynn what they see. Expected: a chromeless terminal bubble with live shell content. If empty/collapsed, check:

- the destination host in `destination.address` is reachable from the provider
- Provider baseUrl is correct and reachable from device
- Stream session key is a valid per-user Clawline key

## Quick reference

| Field              | Value                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| MIME type          | `application/vnd.clawline.terminal-session+json`                           |
| WS path            | `/ws/terminal`                                                             |
| Auth mode          | `chat_token`                                                               |
| Descriptor version | provider-generated `2`                                                     |
| Routing authority  | `destination.address`                                                      |
| tmux session id    | optional caller-supplied `terminalSessionId`, otherwise provider-generated |
| tmux location      | Host named by `destination.address`                                        |

## Common patterns

**Debug shell for Flynn:**
Send a new destination-aware request. The provider will create the backing tmux session on first attach. Good for showing live logs, running commands, or debugging.

**Attach to existing agent session:**
Send a destination-aware request with `terminalSessionId` set to the existing tmux session name on that destination host.

**Tail logs:**
Out of scope for this minimal routing slice unless another product surface intentionally writes that command into the created shell.

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
