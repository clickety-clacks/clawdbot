# Upstream Parity Audit

## Scope
- Compared: `upstream/main` vs `upstream-merge-2026-02-14`
- Command used:
  - `git diff upstream/main upstream-merge-2026-02-14 -- . ':(exclude)extensions/clawline' ':(exclude)rebase-reports' ':(exclude)src/clawline'`

## A) Files That Differ (excluding pure Clawline extension/report/src-clawline paths)

| File | Category | + | - |
|---|---:|---:|---:|
| `AGENTS.md` | ADDITIVE | 7 | 0 |
| `CLAUDE.md` | REMOVED | 0 | 1 |
| `UPSTREAM-MERGE.md` | ADDITIVE | 48 | 0 |
| `docs/clawline/gateway-vs-provider.md` | ADDITIVE | 367 | 0 |
| `docs/providers/clawline.md` | ADDITIVE | 90 | 0 |
| `package.json` | MODIFIED | 85 | 48 |
| `pnpm-lock.yaml` | MODIFIED | 1032 | 1056 |
| `pnpm-workspace.yaml` | ADDITIVE | 1 | 0 |
| `src/agents/pi-embedded-runner/model.test.ts` | ADDITIVE | 43 | 0 |
| `src/agents/pi-embedded-runner/model.ts` | MODIFIED | 120 | 6 |
| `src/commands/models/list.list-command.forward-compat.test.ts` | MODIFIED | 27 | 28 |
| `src/commands/models/list.list-command.ts` | MODIFIED | 22 | 28 |
| `src/commands/models/list.registry.ts` | ADDITIVE | 2 | 0 |
| `src/config/config.legacy-config-detection.accepts-imessage-dmpolicy.e2e.test.ts` | ADDITIVE | 11 | 0 |
| `src/config/legacy.migrations.part-3.ts` | MODIFIED | 15 | 22 |
| `src/config/plugin-auto-enable.test.ts` | ADDITIVE | 12 | 0 |
| `src/config/types.channels.ts` | MODIFIED | 3 | 16 |
| `src/config/types.clawline.ts` | ADDITIVE | 56 | 0 |
| `src/config/types.ts` | ADDITIVE | 1 | 0 |
| `src/infra/outbound/message-action-runner.test.ts` | ADDITIVE | 64 | 0 |
| `src/infra/outbound/message-action-runner.ts` | MODIFIED | 452 | 92 |
| `src/plugin-sdk/index.ts` | ADDITIVE | 5 | 0 |

## B) Categorization Rules Applied
- `ADDITIVE`: file added, or file modified with only added lines (`-0`).
- `MODIFIED`: existing file where upstream lines were changed/removed (`-N` > 0).
- `REMOVED`: upstream file deleted in branch.

## C) MODIFIED/REMOVED Findings (with exact line evidence)

### 1) `CLAUDE.md` — REMOVED
- Diff evidence:
  - `@@ -1 +0,0 @@`
  - `-AGENTS.md`
- Assessment: **Problem** (upstream file removed).

### 2) `package.json` — MODIFIED
- Diff evidence:
  - `@@ -3,2 +3,2 @@`
  - `-  "version": "2026.2.13",`
  - `+  "version": "2026.2.6-3",`
  - `-  "description": "Multi-channel AI gateway with extensible messaging integrations",`
  - `+  "description": "WhatsApp gateway CLI (Baileys web) with Pi RPC agent",`
  - `@@ -27,8 +27 @@`
  - `-    "./plugin-sdk": { ... },`
  - `-    "./plugin-sdk/account-id": { ... },`
  - `+    "./plugin-sdk": "./dist/plugin-sdk/index.js",`
- Assessment: **Problem** (core metadata/exports/scripts/dependency behavior changed, not purely additive).

### 3) `pnpm-lock.yaml` — MODIFIED
- Diff evidence:
  - `@@ -10 +10,3 @@`
  - `-  qs: 6.14.2`
  - `+  '@hono/node-server>hono': 4.11.8`
  - `+  hono: 4.11.8`
  - `+  qs: 6.14.1`
  - plus many dependency version rollbacks/changes.
- Assessment: **Problem** (lockfile reflects non-additive dependency graph changes).

### 4) `src/agents/pi-embedded-runner/model.ts` — MODIFIED
- Diff evidence:
  - `@@ -7 +6,0 @@`
  - `-import { resolveForwardCompatModel } from "../model-forward-compat.js";`
  - large inserted replacement block for codex/anthropic fallback paths.
- Assessment: **Potentially risky/problem** (upstream logic path replaced, not additive-only).

### 5) `src/commands/models/list.list-command.forward-compat.test.ts` — MODIFIED
- Diff evidence:
  - `@@ -7 +7 @@`
  - `- ... "openai-codex/gpt-5.3-codex"`
  - `+ ... "openai-codex/gpt-5.3-codex-spark"`
  - `@@ -68,7 +71,3 @@`
  - removed mock of `resolveForwardCompatModel`, switched to `resolveModel`.
- Assessment: **Likely safe test churn**, but **not additive**.

### 6) `src/commands/models/list.list-command.ts` — MODIFIED
- Diff evidence:
  - removed model registry / forward-compat fallback path:
    - `-import { resolveForwardCompatModel } ...`
    - removed `if (!model && modelRegistry) { ... }`
  - changed error handling:
    - `- runtime.error(\`Model registry unavailable:\n${formatErrorWithStack(err)}\`)`
    - `+ runtime.error(\`Model registry unavailable: ${String(err)}\`)`
- Assessment: **Problem** (existing upstream behavior altered).

### 7) `src/config/legacy.migrations.part-3.ts` — MODIFIED
- Diff evidence:
  - migration replaced:
    - `- id: "memorySearch->agents.defaults.memorySearch"`
    - `+ id: "clawline->channels.clawline"`
  - removal of memorySearch migration behavior and deletion changed to `delete raw.clawline`.
- Assessment: **Problem** (upstream migration behavior removed/replaced).

### 8) `src/config/types.channels.ts` — MODIFIED
- Diff evidence:
  - removed upstream extension config type block:
    - `- export type ExtensionChannelConfig = { ... }`
  - index signature narrowed:
    - `- [key: string]: any;`
    - `+ [key: string]: unknown;`
  - added `clawline?: ClawlineConfig`.
- Assessment: **Mixed**: clawline field is additive, but removal of `ExtensionChannelConfig` is **non-additive/problematic**.

### 9) `src/infra/outbound/message-action-runner.ts` — MODIFIED
- Diff evidence:
  - removed centralized param helper imports:
    - `- import { hydrateSendAttachmentParams, ... } from "./message-action-params.js";`
  - removed helper:
    - `- function resolveAndApplyOutboundThreadId(...)`
  - reintroduced large inline logic block (read/normalize/hydration/thread helpers) and changed import set.
- Assessment: **Problem/high-risk** (core outbound action behavior changed materially; not additive-only).

## Verdict
- Requirement 1 (**no upstream functionality changed/removed unless additive**) is **NOT satisfied**.
- Requirement 2 (**all upstream-file changes additive-only**) is **NOT satisfied**.
- Blocking files are all `MODIFIED/REMOVED` items above, especially:
  - `package.json`
  - `pnpm-lock.yaml`
  - `src/commands/models/list.list-command.ts`
  - `src/config/legacy.migrations.part-3.ts`
  - `src/config/types.channels.ts`
  - `src/infra/outbound/message-action-runner.ts`
  - `CLAUDE.md`
