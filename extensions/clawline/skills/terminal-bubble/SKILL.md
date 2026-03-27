---
name: terminal-bubble
description: Send a live terminal bubble into a Clawline chat stream. The bubble connects to a tmux session on TARS via WebSocket and renders an interactive terminal inside the message flow. Use when Flynn asks to send a terminal, share a tmux session, show a live shell, or embed a terminal in chat. Also use when another skill or workflow needs to surface a live terminal session to the user.
---

# Terminal Bubble

Send an interactive terminal bubble to a Clawline stream. The bubble renders a live tmux session inside the chat message flow via SwiftTerm + WebSocket.

## Prerequisites

- Clawline provider running on TARS (port 18800)
- A tmux session on TARS (created or existing)
- Target stream must be a per-user Clawline session (`:main`, `:dm`, or custom `s_*`)

## Procedure

### 1. Determine target stream

Default to the **current session's stream**. Extract the stream suffix from the session key:

```
agent:main:clawline:flynn:s_417c16a8  →  target = "flynn:s_417c16a8"
agent:main:clawline:flynn:main        →  target = "flynn:main"
```

If Flynn specifies a different stream, use that.

### 2. Ensure tmux session exists on TARS

The `terminalSessionId` in the descriptor must match a tmux session name on TARS (local mode).

**Use an existing session:**

```bash
tmux list-sessions | grep <session-name>
```

**Or create one:**

```bash
tmux new-session -d -s <session-name> -c /Users/mike 'zsh'
```

Keep names short, lowercase, hyphenated. Examples: `clu-term-test`, `gateway-logs`, `debug-shell`.

### 3. Construct and send the descriptor

Build the JSON descriptor, base64 encode it, and send via `message sendAttachment`.

**Descriptor format:**

```json
{
  "version": 1,
  "terminalSessionId": "<tmux-session-name>",
  "title": "<human-readable title>",
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

**Required fields:** `version` (always `1`), `terminalSessionId`
**Strongly recommended:** `provider.baseUrl` (without it, client falls back to stored pairing URL which may be empty)

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

- tmux session exists **on TARS** (not eezo — provider runs locally)
- Provider baseUrl is correct and reachable from device
- Stream session key is a valid per-user Clawline key

## Quick reference

| Field              | Value                                            |
| ------------------ | ------------------------------------------------ |
| MIME type          | `application/vnd.clawline.terminal-session+json` |
| Provider URL       | `http://TARS.local:18800`                        |
| WS path            | `/ws/terminal`                                   |
| Auth mode          | `chat_token`                                     |
| Descriptor version | `1`                                              |
| tmux location      | TARS local (not eezo)                            |

## Common patterns

**Debug shell for Flynn:**
Create a fresh tmux session and send it. Good for showing live logs, running commands, or debugging.

**Attach to existing agent session:**
If a tmux agent session exists on TARS, send a bubble pointing at it. Flynn can watch the agent work in real time.

**Tail logs:**
Create a tmux session running `tail -f <logfile>`, send as bubble. Live log viewer in chat.

## Tmux mode: local vs SSH

The provider supports two tmux modes, configured in `openclaw.json` under the Clawline plugin config at `terminal.tmux`:

**Local mode** (default): tmux sessions must exist on TARS.

```json
{ "terminal": { "tmux": { "mode": "local" } } }
```

**SSH mode**: tmux commands run over SSH to a remote host (e.g. eezo). This lets terminal bubbles connect to remote tmux sessions where coding agents live.

```json
{
  "terminal": {
    "tmux": {
      "mode": "ssh",
      "ssh": {
        "target": "mike@eezo",
        "identityFile": "/Users/mike/.ssh/id_ed25519_clu"
      }
    }
  }
}
```

Check current mode before sending — if set to `local`, the tmux session must be on TARS. If `ssh`, it must be on the configured remote host.

After changing the config, restart the gateway (`openclaw gateway restart`).

## Known limitations

- **30-second offscreen teardown:** If the bubble scrolls off-screen for 30+ seconds, the terminal disconnects and requires manual reconnect tap.
- **Terminal history not preserved** across cell reuse/recreation in the chat scroll.
- **Error UX is generic:** Many failure modes collapse into a disconnected overlay.
- **Single host:** The provider connects to one tmux host at a time (local or one SSH target). Cannot mix local and remote sessions simultaneously.
