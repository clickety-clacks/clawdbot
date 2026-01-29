---
name: clawline-media
description: Locate and retrieve Clawline uploaded assets from disk or the local download endpoint.
metadata: {"clawdbot":{"skillKey":"clawline-media"}}
---

# Clawline Media and Assets

Clawline stores uploaded assets on disk. By default:
- Base path: `~/.clawdbot/clawline-media` (override with `clawline.media.storagePath`).
- Assets directory: `~/.clawdbot/clawline-media/assets/`.

Each asset file name is the asset ID from the message payload, e.g. `a_f45e...`.

## Preferred (Local) Access

```bash
cat ~/.clawdbot/clawline-media/assets/a_123 > /tmp/a_123.bin
file --mime-type /tmp/a_123.bin
```

Use the attachment's MIME type when provided; otherwise inspect with `file --mime-type`.

## Fallback (Local HTTP)

```bash
curl -f -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:<port>/download/a_123" \
  -o /tmp/a_123.bin
```

Prefer the filesystem path when available to avoid extra hops.
