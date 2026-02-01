---
name: clawline-allowlist
description: Inspect and reason about Clawline allowlist, pending, and denylist entries plus identity fields.
metadata: { "openclaw": { "skillKey": "clawline-allowlist" } }
---

# Clawline Allowlist and Identity

## Key Files

All files live under `~/.openclaw/clawline/` by default (override with `clawline.statePath`).

- `allowlist.json` - approved devices
- `pending.json` - waiting for approval
- `denylist.json` - devices to reject immediately

The provider watches allowlist/pending for changes, so edits take effect without a restart.

## Identity Fields

- `deviceId`: stable per device/app install.
- `claimedName`: human-friendly label from the device; display-only.
- `userId`: server-assigned routing identity; authoritative.
- `isAdmin`: computed from `userId` by the server policy when allowlist reloads.
- `bindingId`: optional secondary identifier for devices that migrate.

UserId policy:

- If `claimedName` is present, the server normalizes it (lowercase, punctuation -> `_`).
- If the normalized name is empty, the server generates `user_<uuid>`.
- Admin status is derived from the deployment's reserved admin userId; do not set `isAdmin` manually.

## Inspect Entries

```bash
jq ".entries" ~/.openclaw/clawline/pending.json 2>/dev/null
jq ".entries" ~/.openclaw/clawline/allowlist.json 2>/dev/null
jq "." ~/.openclaw/clawline/denylist.json 2>/dev/null
```

## When You Need to Change userId

Tokens are bound to the `userId` stored in allowlist. To migrate a device:

1. Remove the allowlist entry.
2. Re-pair the device from the app.
3. Approve the new pending request with the desired `userId`.
