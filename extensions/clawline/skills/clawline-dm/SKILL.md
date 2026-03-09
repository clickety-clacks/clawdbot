---
name: clawline-dm
description: Resolve a Clawline stream by display name and send messages to it. Use when Flynn asks you to talk to, ping, or ask another agent/stream directly. Acts as stream-aware chat DNS — look up the name, send to the session.
---

# Clawline DM

Translate a stream display name to a session key, then send messages to it via `sessions_send`.

## Step 1 — Resolve the stream name

The Clawline provider stores stream names in its SQLite database:

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT sessionKey, displayName FROM stream_sessions WHERE userId='flynn' ORDER BY orderIndex;"
```

Targeted lookup (name → key):

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT sessionKey FROM stream_sessions WHERE userId='flynn' AND displayName='STREAM_NAME' LIMIT 1;"
```

Reverse lookup (key → name):

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT displayName FROM stream_sessions WHERE sessionKey='SESSION_KEY' LIMIT 1;"
```

**DB:** `~/.openclaw/clawline/clawline.sqlite` · **Table:** `stream_sessions` · **Cols:** `userId, sessionKey, displayName, orderIndex`

Default userId for Flynn's streams: `'flynn'`

## Step 2 — Send the message

Use the `/alert` endpoint — **not** `sessions_send`. `sessions_send` blocks waiting for a return value that never arrives in cross-stream use.

```bash
curl -s -X POST http://localhost:18800/alert \
  -H "Content-Type: application/json" \
  -d '{"sessionKey": "<resolved-key>", "message": "<your message>"}'
```

## Tips

- **Always include your session key** in the message body so the recipient knows how to reply back: e.g. `"Reply via POST to http://localhost:18800/alert with sessionKey agent:main:clawline:flynn:s_XXXX"`
- For multi-turn conversations, keep a brief recap in each message — the other agent has its own context window
- Get your own session key from `session_status` (🧵 Session line) before sending
