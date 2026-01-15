name: clawline
description: Teach Clawdbot how the Clawline mobile provider works: why the allowlist exists, how to pair/reset devices, what the user sees in the iOS/Android clients, how to restart the gateway/sidecar, and how to diagnose socket or rate-limit problems. Use this when users ask about clawline UX, want their device paired/unblocked, or need the allowlist/denylist adjusted on hosts such as tars.
---

# Clawline Allowlist

## Overview

Clawline is the local/mobile provider that the iOS + Android Clawline apps talk to over `http(s)://<gateway>:18792`.  
The allowlist (`~/.clawdbot/clawline/allowlist.json`) is the source of truth for which device IDs are trusted, whether they are admins, and whether their pairing token has been delivered. Manual edits therefore control who can reach the socket at all.

Use this skill whenever you need to:
- pair a new phone or reset one that lost its token
- explain what the allowlist does and how it differs from `denylist.json`
- reissue/revoke a device token outside of the UI
- confirm the Clawline HTTP/WS endpoints are alive after config changes
- restart the gateway sidecar when the allowlist file is changed by hand

## Key Paths & Defaults

- State path: `~/.clawdbot/clawline` (configurable via `clawline.statePath`)
- Allowlist file: `${statePath}/allowlist.json` (schema below)
- Denylist file: `${statePath}/denylist.json` (hot-reloaded watcher)
- Media path: `~/.clawdbot/clawline-media`
- Default bind: `127.0.0.1:18792`. When binding to anything else you must set `clawline.network.allowInsecurePublic=true` **and** populate `clawline.network.allowedOrigins`.
- tars restart flow: `ssh tars 'PATH="/opt/homebrew/bin:$PATH" tmux kill-session -t clawgate; cd ~/src/clawdbot && PATH="$HOME/Library/pnpm:/opt/homebrew/bin:$PATH" tmux new-session -d -s clawgate "pnpm clawdbot gateway"'`

`allowlist.json` entries:

```json5
{
  "version": 1,
  "entries": [
    {
      "deviceId": "UUIDv4",
      "claimedName": "Mike's iPhone",        // optional label shown to admins
      "deviceInfo": {                        // sanitized copy of app handshake
        "platform": "iOS" | "Android",
        "model": "iPhone 15",
        "osVersion": "17.2.1",
        "appVersion": "2026.1.5"
      },
      "userId": "user_<uuid>",               // server-generated user identity
      "isAdmin": true | false,
      "tokenDelivered": true | false,        // false => next pairing request re-sends token
      "createdAt": 1768346561762,            // ms epoch
      "lastSeenAt": 1768436564355 | null
    }
  ]
}
```

⚠️ The gateway loads the allowlist once at startup. Any manual file edits require a gateway restart to take effect. (Only the denylist has a file watcher.)

## Workflow

### 1. Health check / discovery

1. Verify the process is running: `curl -sS http://<host>:18792/version` should return `{"protocolVersion":1}`.  
2. Spot-check WS upgrades: use Node/Bun `ws` to connect (`node -e 'const ws=new (require("ws"))("ws://.../ws"); ...'`). Receiving `{"type":"error","code":"invalid_message"}` for a dummy payload confirms the socket is alive.  
3. If either fails, restart the gateway (see commands above) and tail `~/.clawdbot/logs/gateway.log`.

### 2. Inspect current allowlist state

```bash
cd ~/.clawdbot/clawline
cat allowlist.json | jq '{entries: [.entries[] | {deviceId, userId, isAdmin, claimedName, lastSeenAt}] }'
```

Notes:
- Admin detection is `entry.isAdmin === true`. The first paired device becomes admin automatically when the list is empty (`server.ts:1628-1650`).
- `lastSeenAt: null` means the device has never authenticated with the issued token.
- To list pending devices still waiting on approval, query `pendingPairs` via gateway logs (`[clawline] pending pair`). Manual allowlist edits bypass the admin approval flow entirely, so only use them when you trust the device identity.

### 3. Add or update an allowlist entry manually

Use Python to maintain JSON fidelity (avoids jq quoting issues):

```bash
python3 - <<'PY'
import json, pathlib, time, uuid
state = pathlib.Path.home() / ".clawdbot" / "clawline" / "allowlist.json"
data = json.loads(state.read_text()) if state.exists() else {"version": 1, "entries": []}

entry = {
    "deviceId": "INSERT-DEVICE-UUID",
    "claimedName": "INSERT LABEL",
    "deviceInfo": {"platform": "iOS", "model": "iPhone", "osVersion": "17.2.1", "appVersion": "2026.1.5"},
    "userId": "user_" + str(uuid.uuid4()),
    "isAdmin": True,
    "tokenDelivered": False,
    "createdAt": int(time.time() * 1000),
    "lastSeenAt": None,
}

data["entries"] = [e for e in data["entries"] if e["deviceId"] != entry["deviceId"]]
data["entries"].append(entry)
state.write_text(json.dumps(data, indent=2) + "\n")
PY
```

- `tokenDelivered=false` tells Clawline to return the token on the very next `pair_request` from that device ID.  
- Set `isAdmin=true` only for trusted devices—admins can approve other pairings via the app.  
- For an existing user restoring access, re-use the same `userId` (grab it from the file before overwriting) so history stays linked.

### 4. Reissue a token for an existing device

If the device already has an entry:
1. Set `tokenDelivered` to `false` and `lastSeenAt` to `null`.
2. Restart the gateway. On the next pairing attempt the server will resend the JWT with the same `userId`.
3. Optional: if the device was soft-deleted, you can also refresh `createdAt` to now for auditing clarity.

### 5. Revoke or block a device

**Immediate cut-off (hot reload):**
1. Append `{ "deviceId": "<uuid>", "reason": "lost phone", "createdAt": 1768... }` to `~/.clawdbot/clawline/denylist.json`.  
2. The server watches this file; matching sessions are force-closed with `token_revoked`.

**Permanent removal:**
1. Delete the entry from `allowlist.json`.  
2. Restart the gateway so the removal is loaded.  
3. (Optional) Leave the denylist entry for belt-and-suspenders if you expect the token to resurface.

### 6. Restart after manual edits

- **Local dev:** run `pnpm clawdbot gateway` (Ctrl+C, rerun) or `scripts/restart-mac.sh` on macOS.  
- **tars (production-like):**
  ```bash
  ssh -i ~/.ssh/id_ed25519_tars -o IdentitiesOnly=yes tars \
    'PATH="/opt/homebrew/bin:$PATH" tmux kill-session -t clawgate; \
      cd ~/src/clawdbot && PATH="$HOME/Library/pnpm:/opt/homebrew/bin:$PATH" \
      tmux new-session -d -s clawgate "pnpm clawdbot gateway"'
  ```
- Always watch `~/.clawdbot/logs/gateway.log` for `[clawline] listening on ...` to confirm it bound to the port. If you see `commands.native: Invalid input...`, fix `~/.clawdbot/clawdbot.json` and restart again.

### 7. Smoke-test after restart

```bash
curl -sS http://localhost:18792/version

node - <<'JS'
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:18792/ws');
ws.once('open', () => ws.send(JSON.stringify({type: 'ping_test'})));
ws.once('message', (msg) => { console.log(msg.toString()); ws.close(); });
ws.once('error', (err) => { console.error(err); process.exit(1); });
JS
```

Use `tailscale serve status` or `curl https://tars.tail4105e8.ts.net/version` when testing over the tailnet (port-forwarded).

### 8. Explain the system to users

- **Allowlist** = who is trusted + role (admin/user) + token bookkeeping.  
- **Denylist** = emergency kill switch (hot reload).  
- Pairing flow: a device sends `pair_request`; admins approve via their app, which calls `pair_decision`. Manual allowlist edits bypass that flow, so reserve them for operational fixes or bootstrap scenarios.  
- Admin creation: first device in an empty allowlist becomes admin automatically. To add another admin later, set `isAdmin=true` manually or elevate via the UI.

### 9. Mobile UX walkthrough

**New device (no admins yet)**  
1. User opens the Clawline app, enters the Gateway URL or scans the QR.  
2. App shows “Pairing…” while it pings `/version` and then tries the WebSocket.  
3. Because no admins exist, the server auto-approves, the phone immediately sees “Paired as admin” and lands in the inbox. No additional prompts.

**Subsequent device**  
1. User opens the app, enters URL, sees “Requesting approval”.  
2. Existing admins receive a notification banner + inbox card with the device name the user typed (“Pixel 8 Pro”) and Accept/Deny buttons. Pending requests are listed under Settings → Clawline Devices as well.  
3. Admin taps Accept → requester sees “Approved! Fetching messages” as the JWT arrives; Deny shows “Pairing denied, ask an admin or try again later”.

**Restore/Reissue**  
1. User with a formerly paired phone reinstalls the app. After entering URL it jumps straight to “Downloading token…” because the allowlist entry already exists.  
2. If you manually set `tokenDelivered=false`, the app briefly shows “Token reissued” before the standard inbox view.  
3. If the device was removed, it falls back to the pending flow above (admins must re-approve).

**Revoked device**  
1. Device already connected suddenly sees “Session expired (token revoked)” when you add it to the denylist; the socket closes.  
2. Attempts to re-pair show “Pairing denied” until you clear the denylist entry.

### 10. End-to-end pairing lifecycle (reference)

1. **Client boot** → mobile app generates/stores a UUID (deviceId) + device info, then opens a WS connection and sends `pair_request` containing protocolVersion/deviceId/deviceInfo/claimedName.  
2. **Server receives request**  
   - Rejects immediately if deviceId format invalid, denylisted, or rate-limited.  
   - If the allowlist already contains that device with `tokenDelivered=false`, it re-sends the JWT and closes the socket.  
   - If no admin exists yet, it auto-creates a new allowlist entry with `isAdmin=true`, writes it to disk, emits the JWT, and closes the socket.  
   - Otherwise it stores a `pendingPairs` entry keyed by deviceId and notifies all connected admins via `pair_pending`.  
3. **Admin approval** (mobile UI) → admin session sends `pair_decision` with `deviceId`, `approve`, and `userId` (usually prefilled).  
4. **Server outcome**  
   - Approve: creates/updates the allowlist entry, marks `tokenDelivered=false`, issues JWT, notifies the waiting socket with `pair_result success`, and deletes the pending request.  
   - Deny: sends `pair_result success:false reason:"pair_denied"`, tracks the deviceId in `deniedDevices` for a cooling-off window, then drops the pending entry.  
5. **Auth/login** → client connects again with `auth` (token + deviceId). Server verifies JWT, ensures pending pairs don’t exist for that device, registers a session, updates `lastSeenAt`, and replays missed events.  
6. **Long-term state** → device keeps its JWT until it expires or is revoked. To force re-login, set `tokenDelivered=false` (or remove the entry) and restart. To revoke immediately, add to `denylist.json`.

Remind requestors that Clawline is for “external things that talk to the agent” (phones). The allowlist has nothing to do with WhatsApp/Telegram provider allowlists even though the names overlap; those live in `clawbot.json`.
