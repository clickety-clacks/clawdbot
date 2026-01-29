---
name: clawline-gateway-ops
description: Restart and validate the Clawline provider, plus key health checks and rate-limit knobs.
metadata: {"clawdbot":{"skillKey":"clawline-gateway-ops"}}
---

# Clawline Gateway Ops

## Restart

Use your normal service manager or wrapper (not tmux) to restart the gateway. Verify by checking the process and port, not tmux state.

## Health Checks

```bash
curl -sS http://127.0.0.1:18792/version
```

Expected: `{"protocolVersion":1}`

```bash
wscat -c ws://127.0.0.1:18792/ws
```

Send any invalid message and expect `invalid_message`.

## Rate Limits and Session Limits

Configuration lives under `channels.clawline` in `~/.clawdbot/clawdbot.json`.

Common keys:
- `pairing.maxRequestsPerMinute`
- `pairing.maxPendingRequests`
- `sessions.maxMessagesPerSecond`
- `sessions.maxMessageBytes`

Inspect current overrides:

```bash
jq ".channels.clawline" ~/.clawdbot/clawdbot.json
```
