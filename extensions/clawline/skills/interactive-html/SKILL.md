---
name: interactive-html
description: Send interactive HTML bubbles on Clawline via `message.sendAttachment`. Use for interactive prompts, dashboards, and reports that should render as widgets instead of raw HTML or plain text.
metadata: { "openclaw": { "skillKey": "interactive-html" } }
---

# Interactive HTML Bubbles (Clawline)

Use interactive HTML bubbles for Clawline when the user should see an inline widget instead of raw
HTML or plain text.

- Use this for yes/no, multiple-choice, verification pickers, batch forms, dashboards, and report widgets.
- When interactive HTML is available, do not ask users to type plain-text choices.
- For Clawline dashboard or report delivery, use this skill and the transport contract below. Do not
  send raw HTML, markdown-only summaries, or plain-text report dumps when an inline widget is the
  expected deliverable.

## Transport Contract

- MIME type: `application/vnd.clawline.interactive-html+json`
- Payload object: `{"version":1,"html":"..."}`
- Encode payload object as base64 and send that as `buffer`.
- Send via the `message` tool with:
  - `action: "sendAttachment"`
  - `contentType: "application/vnd.clawline.interactive-html+json"`
  - `buffer: "<base64 payload>"`

Example call shape:

```json
{
  "action": "sendAttachment",
  "target": "user:<id>",
  "contentType": "application/vnd.clawline.interactive-html+json",
  "buffer": "<base64({\"version\":1,\"html\":\"<html>...</html>\"})>"
}
```

> **Targeting a specific stream:** Use a fully qualified session key as `target` to deliver into a specific Clawline stream rather than the user's default stream.
>
> ```json
> {
>   "action": "sendAttachment",
>   "target": "agent:main:clawline:flynn:s_4a2b448d",
>   "contentType": "application/vnd.clawline.interactive-html+json",
>   "buffer": "<base64({\"version\":1,\"html\":\"<html>...</html>\"})>"
> }
> ```
>
> Using `target: "flynn"` or `target: "user:<id>"` routes to the user's **default/personal stream**. To keep attachments in the current session, pass the full session key (available from `session_status`).

## HTML Requirements

- Must include viewport meta tag:
  - `<meta name="viewport" content="width=device-width, initial-scale=1">`
- Do not include your own CSP meta tag. The client injects CSP automatically.
- Client theme variables are injected; use:
  - `--clawline-bubble-bg`
  - `--clawline-fg`

## JS Bridge Contract

Send callbacks through:

```js
window.webkit.messageHandlers.clawline.postMessage({ action: "submit", data: { ... } });
```

- Use key `data`, not `value`. (`value` arrives as null on the client.)
- Payload size limit for callback `data`: 64KB serialized JSON.

Reserved actions:

- `_close`
  - Optional `summary` field:
  - `window.webkit.messageHandlers.clawline.postMessage({ action: "_close", summary: "Done" });`
- `_resize`
  - Include `data.height` or top-level `height`:
  - `window.webkit.messageHandlers.clawline.postMessage({ action: "_resize", data: { height: 280 } });`
  - `window.webkit.messageHandlers.clawline.postMessage({ action: "_resize", height: 280 });`

## Templates

### 1) Yes/No

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 12px;
        background: var(--clawline-bubble-bg);
        color: var(--clawline-fg);
        font:
          16px -apple-system,
          system-ui,
          sans-serif;
      }
      .row {
        display: flex;
        gap: 8px;
      }
      button {
        flex: 1;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
      }
    </style>
  </head>
  <body>
    <p>Proceed with deployment?</p>
    <div class="row">
      <button onclick="pick(true)">Yes</button>
      <button onclick="pick(false)">No</button>
    </div>
    <script>
      const bridge = window.webkit.messageHandlers.clawline;
      function pick(ok) {
        bridge.postMessage({ action: "choice", data: { answer: ok ? "yes" : "no" } });
        bridge.postMessage({ action: "_close", summary: ok ? "Selected Yes" : "Selected No" });
      }
    </script>
  </body>
</html>
```

### 2) Multiple Choice (Radio)

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 12px;
        background: var(--clawline-bubble-bg);
        color: var(--clawline-fg);
        font:
          16px -apple-system,
          system-ui,
          sans-serif;
      }
      fieldset {
        border: 0;
        padding: 0;
        margin: 0 0 10px;
      }
      label {
        display: block;
        margin: 8px 0;
      }
      button {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
      }
    </style>
  </head>
  <body>
    <fieldset>
      <legend>Pick environment</legend>
      <label><input type="radio" name="env" value="dev" checked /> Dev</label>
      <label><input type="radio" name="env" value="staging" /> Staging</label>
      <label><input type="radio" name="env" value="prod" /> Production</label>
    </fieldset>
    <button onclick="submitChoice()">Submit</button>
    <script>
      const bridge = window.webkit.messageHandlers.clawline;
      function submitChoice() {
        const picked = document.querySelector('input[name="env"]:checked');
        const value = picked ? picked.value : "dev";
        bridge.postMessage({ action: "choice", data: { env: value } });
        bridge.postMessage({ action: "_close", summary: "Selected: " + value });
      }
    </script>
  </body>
</html>
```

### 3) Rating (1-5)

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        padding: 12px;
        background: var(--clawline-bubble-bg);
        color: var(--clawline-fg);
        font:
          16px -apple-system,
          system-ui,
          sans-serif;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 8px;
      }
      button {
        padding: 10px 0;
        border-radius: 10px;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
      }
    </style>
  </head>
  <body>
    <p>Rate confidence:</p>
    <div class="grid">
      <button onclick="rate(1)">1</button>
      <button onclick="rate(2)">2</button>
      <button onclick="rate(3)">3</button>
      <button onclick="rate(4)">4</button>
      <button onclick="rate(5)">5</button>
    </div>
    <script>
      const bridge = window.webkit.messageHandlers.clawline;
      function rate(n) {
        bridge.postMessage({ action: "rating", data: { value: n } });
        bridge.postMessage({ action: "_close", summary: "Rating: " + n + "/5" });
      }
    </script>
  </body>
</html>
```
