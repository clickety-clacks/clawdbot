---
summary: "Clawline local-device channel setup and Gateway-hosted runtime"
read_when:
  - You want to connect Clawline local devices to an OpenClaw Gateway
  - You are enabling the bundled Clawline channel
  - You need the Clawline channel config surface
title: "Clawline"
---

Clawline is a bundled local-device channel for the Clawline fork. It runs as a Gateway service on the host, accepts paired Clawline clients, and routes device messages into OpenClaw sessions. It does not provide a third-party chat network integration.

## Before You Begin

You need:

- A Gateway host that can run the bundled `clawline` service.
- A Clawline client that can reach the Gateway host and pair with it.
- A sender policy decision for the local deployment. Clawline pairing and allowlist state is stored under the Clawline state directory.

Keep the listener on loopback unless the Clawline clients reach it through a trusted tunnel, tailnet, or local reverse proxy.

## Quick Setup

Enable the bundled channel:

```json5
{
  channels: {
    clawline: {
      enabled: true,
      port: 18800,
      network: {
        bindAddress: "127.0.0.1",
        allowedOrigins: ["null"],
      },
    },
  },
}
```

Apply it:

```bash
openclaw config patch --file ./clawline.patch.json5 --dry-run
openclaw config patch --file ./clawline.patch.json5
openclaw gateway
```

Check channel status:

```bash
openclaw channels status clawline
```

## Configuration

Common keys:

- `enabled` - starts the Clawline service when the Gateway starts.
- `port` - HTTP/WebSocket port for local Clawline clients. Defaults to `18800`.
- `statePath` - Clawline runtime state directory. Defaults to `~/.openclaw/clawline`.
- `network.bindAddress` - listener address. Defaults to `127.0.0.1`.
- `network.allowedOrigins` - browser/client origins allowed for Clawline HTTP and WebSocket requests.
- `media.storagePath` - uploaded media storage path. Defaults to `~/.openclaw/clawline-media`.
- `sessions.maxReplayMessages` - total replay cap for reconnecting clients.
- `sessions.maxReplayMessagesPerStream` - per-stream replay cap for reconnecting clients.
- `streams.maxStreamsPerUser` - maximum visible streams per Clawline user.
- `streams.maxDisplayNameBytes` - maximum stream display-name length in bytes.
- `server.cluSecret` - optional shared secret for CLU server-side stream lifecycle operations. Leave unset unless an operator explicitly provisions CLU integration.

## Remote Access

Expose Clawline only through a trusted private path. For a remote client, prefer a tailnet or SSH tunnel that preserves the Gateway's loopback listener. If you intentionally bind outside loopback, review [Gateway exposure](/gateway/security/exposure-runbook) first.

## Troubleshooting

- `clawline service failed to start`: confirm the configured port is free and the Gateway host can load the bundled Clawline dependencies.
- Clients cannot pair: confirm `channels.clawline.enabled` is true and the client is connecting to the configured host and port.
- Browser-origin errors: add the exact trusted origin to `channels.clawline.network.allowedOrigins`.
- Reconnect replay misses recent messages: raise `sessions.maxReplayMessages` or `sessions.maxReplayMessagesPerStream`.

## Related

- [Channel configuration](/gateway/config-channels)
- [Pairing](/channels/pairing)
- [Gateway exposure runbook](/gateway/security/exposure-runbook)
