---
name: clawline-webroot
description: Serve static files from the Clawline provider at /www.
metadata: { "openclaw": { "skillKey": "clawline-webroot" } }
---

# Clawline Web Root

The Clawline provider serves static files from a local directory.

## Configuration

- Config key: channels.clawline.webRootPath
- To find the webroot path, try reading the config key first:
  ```
  openclaw config get channels.clawline.webRootPath
  ```
  If no value is set, the default is: `~/.openclaw/workspace/www/`

## Accessing files

URL pattern: `http://<hostname>:<clawline-port>/www/<filename>`

- The port is the Clawline provider port (`channels.clawline.port`, default 18800)
- This is NOT the gateway port or any other internal port
- Example: `http://localhost:18800/www/index.html`

## Usage

```bash
# Find the webroot directory
webRootPath="$(openclaw config get channels.clawline.webRootPath 2>/dev/null || echo ~/.openclaw/workspace/www)"
mkdir -p "$webRootPath"

# Add a file
echo '<h1>Hello</h1>' > "$webRootPath/index.html"

# Verify it serves
curl http://localhost:18800/www/index.html
```

## Security

- Dotfiles blocked (files starting with . return 404)
- Path traversal blocked (.. segments return 404)
- Methods: GET and HEAD only

## Custom Path

Override in config (JSON):

```json
{
  "channels": {
    "clawline": {
      "webRootPath": "/path/to/custom/www"
    }
  }
}
```
