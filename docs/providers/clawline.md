---
title: Clawline
sidebarTitle: Clawline
description: Local mobile provider for the Clawline iOS/Android clients.
---

# Clawline Provider

Clawline exposes a pairing/token-authenticated WebSocket + HTTP server that the
Clawline iOS/Android apps can connect to for chat, uploads, and downloads. The
service runs inside the OpenClaw gateway process, so it shares the same runtime
configuration and adapters as the rest of your deployment.

## Enabling

The provider is disabled by default. Enable it via the onboarding wizard or add
an explicit `channels.clawline.enabled: true` block to configure bind address, port, or
media paths:

```json5
{
  channels: {
    clawline: {
      // Bind to loopback by default; set allowInsecurePublic to true if you bind to 0.0.0.0 or a LAN IP.
      network: {
        bindAddress: "127.0.0.1",
        allowInsecurePublic: false,
        allowedOrigins: ["null"],
      },
      port: 18792,
      statePath: "~/.openclaw/clawline",
      media: {
        storagePath: "~/.openclaw/clawline-media",
      },
    },
  },
}
```

The default `allowedOrigins: ["null"]` matches how the mobile apps connect when their embedded WebViews emit
`Origin: null` (file:// contexts). When you expose the provider beyond loopback, replace this list with the exact
https origins (and set `allowInsecurePublic` accordingly).

Set `channels.clawline.enabled` to `false` (or omit the block) to keep the service
disabled unless a user explicitly enables it.

## Adapter overrides

Clawline reuses the default agent configuration (model, CLI backend, workspace,
timeouts) when generating assistant replies. You can override those settings for
mobile clients without touching the global agent configuration:

```json5
{
  channels: {
    clawline: {
      adapter: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timeoutSeconds: 120,
        responseFallback: "Sorry, something went wrong.",
      },
    },
  },
}
```

## Transport security

The server binds to `127.0.0.1` by default. When binding to any other address
you **must** set `channels.clawline.network.allowInsecurePublic = true` and provide an
allowlist of `network.allowedOrigins`. Run Clawline behind Tailscale, a VPN, or
a reverse proxy with TLS termination for production use.

## Allowlist, pairing, and admin access

Clawline tracks paired devices in `~/.openclaw/clawline/allowlist.json`. Each entry carries
metadata plus an `isAdmin` flag that controls whether the device should see the admin
transcript:

- Tokens now only encode identity (`deviceId` + `userId`); they do **not** embed the admin flag.
- The running provider reloads the allowlist whenever the file changes. Changing `isAdmin`
  immediately updates replay + live fan-out--no need to reissue tokens.
- When a WebSocket authenticates, the server replies with an `auth_result` payload that includes
  `isAdmin: true|false`. Clients can use that field to hide/disable their admin UI, but the
  provider still enforces delivery, so flipping the allowlist entry is authoritative.

During pairing the first approved device automatically becomes admin if no existing entries have
`isAdmin: true`. After that, toggle the flag manually in `allowlist.json` (or via your own tooling)
whenever you need to promote/demote a device.
