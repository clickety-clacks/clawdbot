---
name: clawline-stream-lookup
description: Look up a Clawline session key from a stream display name, or look up a display name from a session key. Use when you need to find which session key corresponds to a named stream like "Engram" or "Dictation".
---

# Clawline Stream Lookup

Translates between Clawline stream display names and session keys using the provider's SQLite database.

## Database

```
~/.openclaw/clawline/clawline.sqlite
```

Table: `stream_sessions`
Columns: `userId TEXT`, `sessionKey TEXT`, `displayName TEXT`, `orderIndex INTEGER`

## Name → Session Key

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT sessionKey FROM stream_sessions WHERE userId='flynn' AND displayName='STREAM_NAME' LIMIT 1;"
```

## Session Key → Name

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT displayName FROM stream_sessions WHERE sessionKey='SESSION_KEY' LIMIT 1;"
```

## List All Streams for a User

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT sessionKey, displayName FROM stream_sessions WHERE userId='flynn' ORDER BY orderIndex;"
```

## List All Users and Their Streams

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT userId, sessionKey, displayName FROM stream_sessions ORDER BY userId, orderIndex;"
```

## Notes

- Default user for Flynn's streams: `userId = 'flynn'`
- Stream names are not necessarily unique — a user can have two streams with the same display name
- If multiple matches, prefer exact case match; return all if still ambiguous
- Session keys follow the pattern `agent:main:clawline:{userId}:{streamId}` where streamId is `main`, `dm`, or `s_{hex}`
