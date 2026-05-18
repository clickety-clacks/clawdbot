---
name: clawline-attachments
description: Send screenshots, images, logs, or generated files as actual Clawline attachments; use when the user asks to attach, send, share, upload, or show a file/screenshot in Clawline.
---

# Clawline Attachments

Use this skill when delivering an outbound file/screenshot/image to Flynn in Clawline.

## Rule

For Clawline, **do not use `MEDIA:/path` as the delivery mechanism**. `MEDIA:` is a web-render directive and may show up as a plain path in Clawline.

Use the `message` tool with `action: "sendAttachment"`.

## Workflow

1. Confirm the file exists and is the intended artifact.
2. Prefer a stable local path under the workspace for generated screenshots/artifacts when practical.
3. Send it with `message.sendAttachment`:
   - `channel: "clawline"`
   - `target`: current chat id when available from inbound metadata (for example `flynn:s_...`), otherwise the known Clawline target
   - `media`: local file path
   - `filename`: friendly basename
   - `caption`: short human caption when useful
4. If the attachment tool call itself delivers the user-visible response, reply with `NO_REPLY` to avoid duplicate text. If the user needs a brief confirmation after the attachment, keep it to one short sentence.

## Example

```json
{
  "action": "sendAttachment",
  "channel": "clawline",
  "target": "flynn:s_784db002",
  "media": "/Users/mike/.openclaw/workspace/racter-clean-main.png",
  "filename": "racter-clean-main.png",
  "caption": "Racter current proof screenshot"
}
```

## Common mistake

Wrong in Clawline:

```text
MEDIA:/Users/mike/.openclaw/workspace/racter-clean-main.png
```

That may render as a path instead of an attachment.
