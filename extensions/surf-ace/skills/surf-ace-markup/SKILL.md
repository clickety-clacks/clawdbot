---
name: surf-ace-markup
description: "Handle Surf Ace markup events — user drew on a surface. Check custom rules first, then use judgment."
metadata: { "openclaw": { "skillKey": "surf-ace-markup" } }
---

# Surf Ace Markup Handler

## When This Skill Applies

A Surf Ace markup event has arrived. The user drew on a surface you pushed content to and went idle for ~3.5 seconds. The surface has sent you a screenshot and stroke data.

## Payload

The alert body contains:

```json
{
  "event": "markup",
  "surfaceId": "<fingerprint>",
  "frameId": "<frameId>",
  "contentType": "html|pdf|image|terminal",
  "screenshot": "<base64 PNG>",
  "strokes": [{ "x": 0.42, "y": 0.31, "pressure": 0.7, "type": "begin|move|end" }]
}
```

- `screenshot` — what was on screen when they finished drawing
- `strokes` — normalized 0–1 coordinates, in order
- `contentType` — what kind of content was on the surface

## Step 1: Check Custom Rules

Look for `~/.openclaw/skills/surf-ace-markup/my-rules.md`. If it exists, read it.

Custom rules are plain-English gesture→action pairs, for example:

```
- heart shape → play "Around the World" by Daft Punk
- circle around text → search that text
- X mark → clear the surface
- checkmark → save current frame as a note
```

Run the screenshot + strokes through vision with the question: **"Does this drawing match any of these patterns?"**

If a rule matches — execute it. You're done.

## Step 2: Soft Judgment

No rule matched (or no custom rules file exists). Use what you know:

- **What was on the surface** — you pushed that content; you know what it is
- **Who this user is** — their profile, interests, working context, what they're currently focused on
- **What the markup looks like** — circles usually mean "look at this", X marks usually mean "remove this", arrows usually mean "relate these", underlines usually mean "note this"
- **What makes sense right now** — given the current conversation and active work

Act on your best read. Don't ask the user what they meant — interpret and move. If you're genuinely uncertain between two reasonable interpretations, pick the more useful one.

## Act, Don't Narrate

Don't describe the mechanics ("I received a Surf Ace markup event..."). Just do the thing. Respond as if you noticed what they pointed at and responded naturally.

## Custom Rules File Format

Users can create `~/.openclaw/skills/surf-ace-markup/my-rules.md` with any rules they want. Plain English, one rule per line, `- <gesture> → <action>`. No code needed. Rules are checked in order; first match wins.
