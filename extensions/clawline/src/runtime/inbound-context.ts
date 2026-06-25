import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type InboundMediaFacts,
  type SupplementalContextFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import type { ClawlineStructuredContextEntry } from "./message-reference-context.js";

export type ClawlineInboundReplyReference = {
  id: string;
  fullId?: string;
  body?: string;
  sender?: string;
};

export type BuildClawlineInboundContextParams = {
  channel: string;
  accountId?: string;
  agentId: string;
  sessionKey: string;
  mainSessionKey?: string;
  messageId: string;
  rawBody: string;
  body?: string;
  commandBody?: string;
  fromPeerId: string;
  to: string;
  senderId: string;
  senderName?: string;
  provider?: string;
  surface?: string;
  nativeChannelId?: string;
  originatingChannel?: string;
  originatingTo?: string;
  groupSystemPrompt?: string;
  media?: readonly InboundMediaFacts[];
  replyReference?: ClawlineInboundReplyReference;
  referenceContexts?: readonly ClawlineStructuredContextEntry[];
  untrustedContext?: readonly ClawlineStructuredContextEntry[];
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function canonicalReferenceFromContext(
  context: ClawlineStructuredContextEntry,
): ClawlineInboundReplyReference | undefined {
  if (context.source !== "clawline" || context.type !== "reply_reference") {
    return undefined;
  }
  const id = normalizeString(context.payload.llm_visible_message_id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    body: normalizeString(context.payload.preview),
    sender: normalizeString(context.payload.sender) ?? normalizeString(context.payload.role),
  };
}

function hasOnlyCanonicalReferencePayload(context: ClawlineStructuredContextEntry): boolean {
  const keys = Object.keys(context.payload);
  return keys.every((key) =>
    ["kind", "llm_visible_message_id", "preview", "sender", "role"].includes(key),
  );
}

function resolveReplyReference(params: {
  explicit?: ClawlineInboundReplyReference;
  contexts?: readonly ClawlineStructuredContextEntry[];
}): ClawlineInboundReplyReference | undefined {
  if (params.explicit) {
    return params.explicit;
  }
  for (const context of params.contexts ?? []) {
    const reference = canonicalReferenceFromContext(context);
    if (reference) {
      return reference;
    }
  }
  return undefined;
}

function resolveUntrustedContext(
  contexts: readonly ClawlineStructuredContextEntry[] | undefined,
): ClawlineStructuredContextEntry[] | undefined {
  const entries = (contexts ?? []).filter((context) => {
    if (!canonicalReferenceFromContext(context)) {
      return true;
    }
    return !hasOnlyCanonicalReferencePayload(context);
  });
  return entries.length > 0 ? entries : undefined;
}

export function buildClawlineInboundContext(
  params: BuildClawlineInboundContextParams,
): BuiltChannelInboundEventContext {
  const replyReference = resolveReplyReference({
    explicit: params.replyReference,
    contexts: params.referenceContexts,
  });
  const untrustedContext = [
    ...(resolveUntrustedContext(params.referenceContexts) ?? []),
    ...(params.untrustedContext ?? []),
  ];
  const supplemental: SupplementalContextFacts = {
    groupSystemPrompt: params.groupSystemPrompt,
    quote: replyReference
      ? {
          id: replyReference.id,
          fullId: replyReference.fullId,
          body: replyReference.body,
          sender: replyReference.sender,
          isQuote: true,
        }
      : undefined,
    untrustedContext: untrustedContext.length > 0 ? untrustedContext : undefined,
  };
  const contextParams: BuildChannelInboundEventContextParams = {
    channel: params.channel,
    accountId: params.accountId,
    provider: params.provider ?? params.channel,
    surface: params.surface ?? params.channel,
    messageId: params.messageId,
    from: `${params.channel}:${params.fromPeerId}`,
    sender: {
      id: params.senderId,
      name: params.senderName,
    },
    conversation: {
      kind: "direct",
      id: params.senderId,
      nativeChannelId: params.nativeChannelId,
    },
    route: {
      agentId: params.agentId,
      accountId: params.accountId,
      routeSessionKey: params.sessionKey,
      mainSessionKey: params.mainSessionKey,
    },
    reply: {
      to: params.to,
      nativeChannelId: params.nativeChannelId,
      originatingTo: params.originatingTo ?? params.to,
      replyToId: replyReference?.id,
      replyToIdFull: replyReference?.fullId,
    },
    message: {
      body: params.body ?? params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: {
      commands: {
        authorized: true,
      },
    },
    media: [...(params.media ?? [])],
    supplemental,
    extra: {
      OriginatingChannel: params.originatingChannel ?? params.channel,
    },
  };
  return buildChannelInboundEventContext(contextParams);
}
