---
name: clawline-dm
description: Send a direct message to another agent in a different Clawline session and hold a back-and-forth conversation with it. Use when Flynn asks you to talk to, ask, or instruct another agent directly.
---

# Clawline DM (Direct Message Between Sessions)

Send messages to another agent's Clawline session and have a conversation with it. The other agent responds back to your session via its notify mechanism.

## How It Works

Each Clawline stream has a session key (e.g. `agent:main:clawline:flynn:s_41b510d1`). You can send a message directly to any session using the `sessions_send` tool, and the receiving agent will reply back to you.

## Step 1 — Find the Target Session Key

Use the `clawline-stream-lookup` skill if you know the stream name but not the key:

```bash
sqlite3 ~/.openclaw/clawline/clawline.sqlite \
  "SELECT sessionKey FROM stream_sessions WHERE userId='flynn' AND displayName='STREAM_NAME' LIMIT 1;"
```

Or use `sessions_list` to see active sessions.

## Step 2 — Send a Message

Use the `sessions_send` tool:

```
sessions_send(sessionKey="<target-session-key>", message="<your message>")
```

The receiving agent will process the message and its reply will be delivered back to your current session.

## Step 3 — Continue the Conversation

Keep using `sessions_send` to the same session key to continue the conversation. Each exchange is a full agent turn on their side.

## Example

To ask the Dictation agent what it's working on:

1. Look up session key for "Dictation" stream → `agent:main:clawline:flynn:s_41b510d1`
2. `sessions_send(sessionKey="agent:main:clawline:flynn:s_41b510d1", message="What's your current status on T027?")`
3. Agent responds; reply appears in your session

## Tip: Using /alert

You can also trigger a session via the OpenClaw `/alert` command:

```
/alert agent:main:clawline:flynn:s_41b510d1 Your message here
```

This injects a system alert into the target session, which causes the agent to wake and respond. Useful for one-shot pings. For multi-turn conversations, prefer `sessions_send`.

## Notes

- The target agent's reply will be delivered to your current session as an inbound message
- If the target session is idle, it will wake to process your message
- Keep messages clear — the receiving agent has its own context and may not know what you're referring to
- To have a long conversation, maintain continuity in your messages (brief recap if needed)
- This works with any active session key, not just Clawline streams
