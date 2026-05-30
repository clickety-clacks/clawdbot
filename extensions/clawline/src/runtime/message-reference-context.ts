export type ClawlineStructuredContextEntry = {
  label: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
};

export type ClawlineMessageReference = {
  kind: "message";
  sessionKey: string;
  messageId: string;
  messageRole: "user" | "assistant";
  createdAt: number;
  clientMessageId?: string;
};

export type ClawlineTranscriptMessageRecord = {
  id?: string;
  clientMessageId?: string;
  timestamp?: number;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

type ClawlineReplyReference = {
  kind: "reply";
  llmVisibleMessageId: string;
  role?: string;
  preview?: string;
};

export type ResolvedClawlineVisibleMessageReference = {
  llmVisibleMessageId: string;
  role?: "user" | "assistant";
  preview?: string;
};

export type ClawlineMessageReferenceResolution =
  | {
      ok: true;
      contexts: ClawlineStructuredContextEntry[];
    }
  | {
      ok: false;
      code: "invalid_message" | "unresolved_reference";
      message: string;
    };

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeMessageRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function normalizeReference(value: unknown): ClawlineReplyReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "reply") {
    return null;
  }
  const llmVisibleMessageId = normalizeString(record.llmVisibleMessageId);
  if (!llmVisibleMessageId) {
    return null;
  }
  const role = normalizeMessageRole(record.role);
  const preview = normalizeString(record.preview);
  return {
    kind: "reply",
    llmVisibleMessageId,
    ...(role ? { role } : {}),
    ...(preview ? { preview } : {}),
  };
}

function buildReferenceContext(reference: ClawlineReplyReference): ClawlineStructuredContextEntry {
  return {
    label: `Reply reference: user is replying to message ${reference.llmVisibleMessageId}`,
    source: "clawline",
    type: "reply_reference",
    payload: {
      kind: "reply",
      llm_visible_message_id: reference.llmVisibleMessageId,
      role: reference.role,
      preview: reference.preview,
    },
  };
}

export async function resolveClawlineMessageReferenceContexts(params: {
  references: unknown;
  resolveVisibleMessage?: (
    llmVisibleMessageId: string,
  ) => Promise<ResolvedClawlineVisibleMessageReference | null>;
  resolveReferenceMessage?: (
    reference: ClawlineMessageReference,
  ) => Promise<ClawlineTranscriptMessageRecord | null>;
  resolveTranscriptMessages?: (
    sessionKey: string,
  ) => Promise<ClawlineTranscriptMessageRecord[] | null>;
}): Promise<ClawlineMessageReferenceResolution> {
  if (
    params.references !== undefined &&
    params.references !== null &&
    !Array.isArray(params.references)
  ) {
    return {
      ok: false,
      code: "invalid_message",
      message: "Invalid reference",
    };
  }

  const rawReferences = Array.isArray(params.references) ? params.references : [];
  if (rawReferences.length === 0) {
    return { ok: true, contexts: [] };
  }

  const contexts: ClawlineStructuredContextEntry[] = [];
  for (const rawReference of rawReferences) {
    const reference = normalizeReference(rawReference);
    if (!reference) {
      return {
        ok: false,
        code: "invalid_message",
        message: "Invalid reference",
      };
    }
    const resolved = params.resolveVisibleMessage
      ? await params.resolveVisibleMessage(reference.llmVisibleMessageId)
      : null;
    contexts.push(
      buildReferenceContext({
        ...reference,
        role: resolved?.role ?? reference.role,
        preview: resolved?.preview ?? reference.preview,
        llmVisibleMessageId: resolved?.llmVisibleMessageId ?? reference.llmVisibleMessageId,
      }),
    );
  }

  return { ok: true, contexts };
}
