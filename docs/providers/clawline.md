---
title: Clawline
sidebarTitle: Clawline
description: Local mobile provider for the Clawline iOS/Android clients.
---

# Clawline Provider

Clawline exposes a pairing/token-authenticated WebSocket + HTTP server that the
Clawline iOS/Android apps can connect to for chat, uploads, and downloads. The
service runs inside the Clawdbot gateway process, so it shares the same runtime
configuration and adapters as the rest of your deployment.

## Enabling

The provider is enabled by default. Add a `clawline` block to configure bind
address, port, or media paths:

```json5
{
  clawline: {
    // Bind to loopback by default; set allowInsecurePublic to true if you bind to 0.0.0.0 or a LAN IP.
    network: {
      bindAddress: "127.0.0.1",
      allowInsecurePublic: false,
      allowedOrigins: ["null"]
    },
    port: 18792,
    statePath: "~/.clawdbot/clawline",
    media: {
      storagePath: "~/.clawdbot/clawline-media"
    }
  }
}
```

Set `clawline.enabled` to `false` to disable the service entirely.

## Adapter overrides

Clawline reuses the default agent configuration (model, CLI backend, workspace,
timeouts) when generating assistant replies. You can override those settings for
mobile clients without touching the global agent configuration:

```json5
{
  clawline: {
    adapter: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      timeoutSeconds: 120,
      responseFallback: "Sorry, something went wrong."
    }
  }
}
```

## Transport security

The server binds to `127.0.0.1` by default. When binding to any other address
you **must** set `clawline.network.allowInsecurePublic = true` and provide an
allowlist of `network.allowedOrigins`. Run Clawline behind Tailscale, a VPN, or
a reverse proxy with TLS termination for production use.
