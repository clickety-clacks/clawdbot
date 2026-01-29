---
name: clawline-pairing
description: Approve or deny pending Clawline devices by moving entries between pending, allowlist, and denylist.
metadata: {"clawdbot":{"skillKey":"clawline-pairing"}}
---

# Clawline Pairing: Approve or Deny

Clawline uses a pending -> allowlist flow:
1. Device sends `pair_request`.
2. Provider writes `pending.json` and keeps the socket open.
3. Approving moves the entry to `allowlist.json`.
4. The provider issues the JWT and the client finishes pairing.

Paths (configurable via `clawline.statePath`):
- `~/.clawdbot/clawline/pending.json`
- `~/.clawdbot/clawline/allowlist.json`
- `~/.clawdbot/clawline/denylist.json`

The provider watches pending/allowlist for changes, so edits apply immediately without a restart.

## Inspect Pending

```bash
jq ".entries" ~/.clawdbot/clawline/pending.json 2>/dev/null
```

## Approve a Device

Move the entry from `pending.json` to `allowlist.json` and set a `userId`. The server will normalize the identity and compute `isAdmin` based on its policy when it reloads the file.

```bash
python3 - <<'PY'
import json, pathlib, time, uuid, re, unicodedata
root = pathlib.Path.home() / ".clawdbot" / "clawline"
pending = json.loads((root / "pending.json").read_text())
allowlist_path = root / "allowlist.json"
allowlist = json.loads(allowlist_path.read_text()) if allowlist_path.exists() else {"version": 1, "entries": []}

device_id = "E3F4..."  # fill in
entry = next(e for e in pending["entries"] if e["deviceId"] == device_id)

def normalize(claimed):
    if not claimed:
        return None
    text = unicodedata.normalize("NFKD", claimed)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text[:64] if text else None

user_id = normalize(entry.get("claimedName")) or f"user_{uuid.uuid4()}"
now = int(time.time() * 1000)

pending["entries"] = [e for e in pending["entries"] if e["deviceId"] != device_id]
allowlist["entries"] = [e for e in allowlist["entries"] if e["deviceId"] != device_id]
allowlist["entries"].append({
    "deviceId": entry["deviceId"],
    "claimedName": entry.get("claimedName"),
    "deviceInfo": entry["deviceInfo"],
    "userId": user_id,
    "bindingId": None,
    "isAdmin": False,
    "tokenDelivered": False,
    "createdAt": now,
    "lastSeenAt": None
})

(root / "pending.json").write_text(json.dumps(pending, indent=2) + "\n")
allowlist_path.write_text(json.dumps(allowlist, indent=2) + "\n")
print("Approved", device_id, "as", user_id)
PY
```

## Deny / Block a Device

Remove the device from pending, then optionally add it to `denylist.json` so future attempts are rejected immediately.

```bash
python3 - <<'PY'
import json, pathlib, time
root = pathlib.Path.home() / ".clawdbot" / "clawline"

device_id = "E3F4..."  # fill in

pending_path = root / "pending.json"
pending = json.loads(pending_path.read_text())
pending["entries"] = [e for e in pending["entries"] if e["deviceId"] != device_id]
pending_path.write_text(json.dumps(pending, indent=2) + "\n")

deny_path = root / "denylist.json"
deny = json.loads(deny_path.read_text()) if deny_path.exists() else []
deny.append({"deviceId": device_id, "createdAt": int(time.time() * 1000)})
deny_path.write_text(json.dumps(deny, indent=2) + "\n")
print("Denied", device_id)
PY
```
