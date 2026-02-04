---
name: clawline-webroot
description: Serve static files from the Clawline provider at /www.
metadata: { "openclaw": { "skillKey": "clawline-webroot" } }
---

# Clawline Web Root

The Clawline provider serves static files from a local directory.

## Configuration
- Config key: channels.clawline.webRootPath
- Default: ~/clawd/www (or <workspace>/www)
- URL prefix: /www on Clawline port (default 18800)

## Usage
mkdir -p ~/clawd/www
echo '<h1>Hello</h1>' > ~/clawd/www/index.html
curl http://localhost:18800/www/index.html

## Security
- Dotfiles blocked (files starting with . return 404)
- Path traversal blocked (.. segments return 404)
- Methods: GET and HEAD only

## Custom Path
Override in config:
channels.clawline.webRootPath: '/path/to/custom/www'
