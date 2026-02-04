---
name: clawline-alert-overlay
description: Explain and control the Clawline alert-instructions overlay appended to alerts.
metadata: { "openclaw": { "skillKey": "clawline-alert-overlay" } }
---

# Clawline Alert Instructions Overlay

Clawline can append a short operator note to every alert.

## What It Is

- File: `~/.openclaw/clawline/alert-instructions.md` (override with `clawline.alertInstructionsPath`).
- The provider reads this file on each alert and appends it to the alert body, separated by a blank line.
- The file is created automatically if missing, using the default alert text.

## Disable or Edit

- Leave the file empty or whitespace-only to disable the overlay.
- Deleting the file recreates the default text on next startup.
- No restart is required; the file is read on every alert.

## Size Limits

- The combined alert must stay under `sessions.maxMessageBytes` (default 65,536 bytes).
- If the overlay would exceed the limit, Clawline sends the alert without it and logs `alert_instructions_skipped`.
