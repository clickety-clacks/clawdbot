---
name: clawline-webroot
description: Serve static files from the Clawline provider at /www.
metadata: { "openclaw": { "skillKey": "clawline-webroot" } }
---

# Clawline Web Root

The Clawline provider serves static files from a local directory.

## Configuration
- Config key: channels.clawline.webRootPath
- Discover the resolved path with: `openclaw gateway config.get channels.clawline.webRootPath`
- URL prefix: /www on Clawline port (default 18800)

## Usage
webRootPath="$(openclaw gateway config.get channels.clawline.webRootPath)"
mkdir -p "$webRootPath"
echo '<h1>Hello</h1>' > "$webRootPath/index.html"
curl http://localhost:18800/www/index.html

## Security
- Dotfiles blocked (files starting with . return 404)
- Path traversal blocked (.. segments return 404)
- Methods: GET and HEAD only

## Custom Path
Override in config (JSON):
{
  "channels": {
    "clawline": {
      "webRootPath": "/path/to/custom/www"
    }
  }
}
