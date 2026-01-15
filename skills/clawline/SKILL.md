name: clawline
description: Operate the Clawline mobile provider: approve or deny pending devices, explain the UX to users, restart/verify the gateway, and diagnose allowlist/denylist/rate-limit issues on hosts like tars.
---

# Clawline Pairing Flow (Pending ➜ Allowlist)

Clawline now uses a **pending → allowlist** workflow:

1. The iOS/Android app sends `pair_request`.
2. The provider writes/updates `pending.json` and keeps the socket open.
3. When an operator (you) approves the device, its entry moves to `allowlist.json`.
4. The provider sees the change, issues the JWT, and the client finishes pairing automatically.

There is no longer any in-app admin approval UI—everything is controlled via the JSON files and this skill.

## Key Paths

All paths live under `~/.clawdbot/clawline/` (configurable via `clawline.statePath`):

| File | Purpose |
| --- | --- |
| `allowlist.json` | Approved devices (`deviceId`, `userId`, admin flag, metadata) |
| `pending.json` | Waiting devices (claimed name, platform, requested timestamp) |
| `denylist.json` | Hot-reload kill switch; immediately terminates matching sessions |

The provider now watches **allowlist** and **pending** for changes, so edits take effect without restarting.
Updates propagate immediately (the watcher reacts as soon as the file write completes), so you can approve/deny and tell the user to retry right away.

## Inspect Pending & Allowlist

```bash
# Pending devices (waiting for approval)
ssh -i ~/.ssh/id_ed25519_tars -o IdentitiesOnly=yes tars \
  'jq ".entries" ~/.clawdbot/clawline/pending.json 2>/dev/null'

# Approved devices
ssh -i ~/.ssh/id_ed25519_tars -o IdentitiesOnly=yes tars \
  'jq ".entries" ~/.clawdbot/clawline/allowlist.json 2>/dev/null'
```

Each pending entry looks like:

```json
{
  "deviceId": "E3F4…",
  "claimedName": "Flynn’s iPhone",
  "deviceInfo": { "platform": "iOS", "model": "iPhone 17 Pro" },
  "requestedAt": 1768510800000
}
```

## Approve a Device

Move the entry from `pending.json` to `allowlist.json`. The helper below runs entirely on the gateway host (tars):

```bash
ssh -i ~/.ssh/id_ed25519_tars -o IdentitiesOnly=yes tars 'python3 - <<\"PY\"
import json, pathlib, uuid, time
root = pathlib.Path.home() / ".clawdbot" / "clawline"
pending = json.loads((root / "pending.json").read_text())
allowlist_path = root / "allowlist.json"
allowlist = json.loads(allowlist_path.read_text()) if allowlist_path.exists() else {"version": 1, "entries": []}

device_id = "E3F4..."           # <-- fill in from pending list
entry = next(e for e in pending["entries"] if e["deviceId"] == device_id)

pending["entries"] = [e for e in pending["entries"] if e["deviceId"] != device_id]
allowlist["entries"] = [e for e in allowlist["entries"] if e["deviceId"] != device_id]
allowlist["entries"].append({
    "deviceId": entry["deviceId"],
    "claimedName": entry.get("claimedName"),
    "deviceInfo": entry["deviceInfo"],
    "userId": "user_" + str(uuid.uuid4()),
    "isAdmin": False,
    "tokenDelivered": False,
    "createdAt": int(time.time()*1000),
    "lastSeenAt": None
})

(root / "pending.json").write_text(json.dumps(pending, indent=2) + "\\n")
allowlist_path.write_text(json.dumps(allowlist, indent=2) + "\\n")
print("Approved", device_id)
PY'
```

As soon as the allowlist entry is written:
- The waiting socket receives `pair_result` with the JWT.
- `pending.json` is cleaned up automatically (the provider removes matching entries or, if the device disconnects, it prunes the stale record immediately).

## Deny / Block a Device

1. Remove it from `pending.json`.
2. Optionally add the `deviceId` to `denylist.json` to kill future attempts:

```bash
ssh -i ~/.ssh/id_ed25519_tars -o IdentitiesOnly=yes tars 'python3 - <<\"PY\"
import json, pathlib, time
root = pathlib.Path.home() / ".clawdbot" / "clawline"
pending = json.loads((root / "pending.json").read_text())
device_id = "E3F4..."  # fill in
pending["entries"] = [e for e in pending["entries"] if e["deviceId"] != device_id]
(root / "pending.json").write_text(json.dumps(pending, indent=2) + "\\n")

deny_path = root / "denylist.json"
deny = json.loads(deny_path.read_text()) if deny_path.exists() else []
deny.append({"deviceId": device_id, "createdAt": int(time.time()*1000)})
deny_path.write_text(json.dumps(deny, indent=2) + "\\n")
print("Denied", device_id)
PY'
```

The provider notifies the waiting client (`pair_denied`) and closes the socket.

## Accessing Uploaded Attachments

Clawline stores every uploaded asset in the media directory (defaults to `~/.clawdbot/clawline-media/`). Each file name is the asset ID from the message payload, e.g. `a_f45e...`.

**Preferred (local) workflow**

1. When an event includes `{ "type": "asset", "assetId": "a_123" }`, read the file directly:
   ```bash
   cat ~/.clawdbot/clawline-media/a_123 > /tmp/a_123.bin
   ```
2. Use the MIME type recorded earlier (usually provided alongside the attachment) to interpret it. If unknown, run `file --mime-type`.
3. Clean up any temp copies after processing.

**Fallback (remote or path unknown)**

If you’re not on the gateway host or the media path isn’t mounted, use the provider’s authenticated endpoint:
```bash
curl -f -H "Authorization: Bearer $TOKEN" \
     "http://<gateway-host>:<port>/download/a_123" \
     -o /tmp/a_123.bin
```

This mirrors what the mobile app and adapter do. Either approach yields the same bytes; prefer the local path when possible to avoid unnecessary HTTP hops.

## Explaining the UX to Users

- When the user says “Anyone trying to connect?”, read `pending.json` and summarize device names + wait duration.
- Approvals happen conversationally: “Let Flynn’s iPhone in” ➜ run the approval snippet and confirm.
- Users can retry on the phone; if the socket closed (timeout/denied), the client reconnects and keeps polling automatically.
- The first-ever device still bootstraps itself as admin (empty allowlist). After that, *all* approvals go through this pending flow.

## Gateway Ops (tars)

- **Restart** (only needed if the binary changed):  
  `ssh … tars 'PATH="/opt/homebrew/bin:$PATH" tmux kill-session -t clawgate; cd ~/src/clawdbot && PATH="$HOME/Library/pnpm:/opt/homebrew/bin:$PATH" tmux new-session -d -s clawgate "pnpm clawdbot gateway"'`
- **Health check**:  
  `curl -sS http://tars.tail4105e8.ts.net:18792/version` → `{"protocolVersion":1}`  
  `wscat -c ws://tars.tail4105e8.ts.net:18792/ws` → send junk, expect `invalid_message`.
- **Rate limits** (override via `~/.clawdbot/clawdbot.json`):  
  `pairing.maxRequestsPerMinute`, `pairing.maxPendingRequests`, `sessions.maxMessagesPerSecond`, etc.

## When Things Go Wrong

- **“Rate limited” during pairing** → inspect `clawdbot.json` overrides and ensure the watchdog on tars was updated (run `ssh … cat ~/.clawdbot/clawdbot.json | jq .clawline`).
- **Stuck pending entry** → remove it from `pending.json` (the socket will get `pair_denied`) and ask the user to retry.
- **Tokens not delivered** → confirm the device appears in `allowlist.json` with `"tokenDelivered": false`; the next `pair_request` will resend automatically.
- **Manual allowlist edits** (e.g., restoring a backup) now apply immediately—still restart if you edit schemas or other gateway config files.

Use this skill whenever someone asks about Clawline pairing, wants a device approved/blocked, or needs help interpreting the pending/allow/deny files.
