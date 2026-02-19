# WhatsApp Pattern Review (Previous Base -> New Upstream)

## Scope

- Previous fork base (pre-rebase merge-base vs upstream): `b8f740fb1`
- New upstream base: `9e7aab9ba`
- Reviewed areas:
  - `extensions/whatsapp/*`
  - WhatsApp-adjacent core paths used by extension/runtime flow:
    - `src/channels/plugins/onboarding/whatsapp.ts`
    - `src/channels/plugins/outbound/whatsapp.ts`
    - `src/web/outbound.ts`
    - `src/web/inbound/media.ts`
    - `src/web/inbound/send-api.ts`
    - `src/web/media.ts`
    - `src/infra/outbound/*`
  - Clawline extension:
    - `extensions/clawline/index.ts`
    - `extensions/clawline/src/channel.ts`
    - `extensions/clawline/src/outbound.ts`
    - `extensions/clawline/src/actions.ts`
    - `extensions/clawline/src/config-schema.ts`

## Upstream WhatsApp Changes

### 1. Extension registration / lifecycle

- WhatsApp extension stayed on the plugin-runtime model (`setWhatsAppRuntime(api.runtime)` + `api.registerChannel(...)`) in `extensions/whatsapp/index.ts`.
- `extensions/whatsapp/src/channel.ts` shifted to shared SDK utility usage (`escapeRegExp` imported from plugin-sdk), removing local duplication.
- No major lifecycle contract break in extension startup/shutdown for WhatsApp.

### 2. Outbound target resolution behavior (important)

- Upstream removed fallback behavior that silently redirected to `allowFrom[0]` when target normalization failed or target was missing.
- New behavior is fail-closed with explicit target requirement (`<E.164|group JID>`), both in:
  - `extensions/whatsapp/src/channel.ts`
  - `src/channels/plugins/outbound/whatsapp.ts`

### 3. Outbound send pipeline and integration points

- Core outbound stack gained queueing/recovery and hook-aware flow:
  - write-ahead queue + replay: `src/infra/outbound/delivery-queue.ts`
  - wrapper changes: `src/infra/outbound/deliver.ts`
  - centralized identity plumbing: `src/infra/outbound/identity.ts`
  - centralized message-action param hydration: `src/infra/outbound/message-action-params.ts`
- Core now centralizes/expands outbound context fields (`identity`, `silent`) in adapter types (`src/channels/plugins/types.adapters.ts`).

### 4. Media / attachment handling patterns

- WhatsApp outbound now normalizes markdown for WhatsApp and preserves document filename:
  - `src/web/outbound.ts` (`markdownToWhatsApp`, `fileName` pass-through)
- Inbound media now has MIME fallbacks and carries `fileName`:
  - `src/web/inbound/media.ts`
- Send API now respects provided filename for documents:
  - `src/web/inbound/send-api.ts`
- Media loading hardened and generalized:
  - local path allowlist/roots + `MEDIA:` prefix stripping + more flexible options in `src/web/media.ts`.

### 5. Config shape and onboarding pattern

- WhatsApp onboarding was refactored to dedupe owner allowlist prompting and use shared `pathExists` helper:
  - `src/channels/plugins/onboarding/whatsapp.ts`
- No breaking WhatsApp config schema redesign in this comparison window; changes were mostly behavior/hardening and plumbing.

### 6. Action registration patterns

- WhatsApp extension retained action gating patterns via shared helpers (`createActionGate`) and explicit action handling in `extensions/whatsapp/src/channel.ts`.
- Added focused test coverage for target-resolution semantics:
  - `extensions/whatsapp/src/resolve-target.test.ts`

## Clawline Comparison Against New WhatsApp Patterns

## Already aligned

- **Fail-closed target requirement**: Clawline outbound requires explicit `to` and fails when absent (`extensions/clawline/src/outbound.ts`). This aligns with upstream WhatsApp removal of silent fallback.
- **Plugin runtime registration model**: Clawline also uses runtime plugin registration (`extensions/clawline/index.ts`) consistent with WhatsApp extension model.

## Partially aligned / still old-style

- **Outbound pipeline surface usage**:
  - Clawline outbound adapter does not consume newer outbound context fields (`identity`, `silent`) now present in adapter context contracts.
  - This is not a break today, but it means Clawline is not adopting newer outbound metadata flow that core now supports.
- **Action parameter hydration is custom/isolated**:
  - Clawline `sendAttachment` path in `extensions/clawline/src/actions.ts` uses bespoke parsing and dispatch.
  - Upstream moved toward centralized hydration/normalization for message actions (`src/infra/outbound/message-action-params.ts`) including data URL normalization, filename inference, media source normalization, and size-policy handling.
- **Media attachment semantics**:
  - Clawline outbound media currently sends `{ data, mimeType }` only (`extensions/clawline/src/outbound.ts`), without explicit filename propagation akin to WhatsApp’s updated document filename handling.

## Concrete gaps to consider adopting

1. **Adopt centralized message-action parameter normalization**

- Align Clawline action handling with shared outbound param hydration patterns (or equivalent wrappers) to reduce drift.

2. **Support richer attachment metadata**

- If Clawline protocol supports it, propagate filename (and future metadata) like WhatsApp now does in core send paths.

3. **Accept/use outbound identity and silent context**

- Wire `identity` and `silent` from outbound adapter context for consistency with core outbound evolution.

4. **Tighten target detection semantics**

- Clawline currently uses `looksLikeId: () => true` in `extensions/clawline/src/channel.ts`; this is permissive. Consider a stricter validator (like WhatsApp’s explicit normalizer+validator pair) to reduce accidental misroutes.

## Conclusion

- There are **no critical regressions** where Clawline still depends on deprecated WhatsApp fallback behavior; the most important target-resolution pattern is already aligned.
- Main drift is in **new core outbound integration patterns** (centralized action hydration, richer attachment metadata, identity/silent propagation), where Clawline still uses more bespoke logic.
