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

function normalizeCreatedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractReadableContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return [];
    }
    const record = part as Record<string, unknown>;
    const text = normalizeString(record.text);
    return text ? [text] : [];
  });
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function normalizeReference(value: unknown): ClawlineMessageReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "message") {
    return null;
  }
  const sessionKey = normalizeString(record.sessionKey);
  const messageId = normalizeString(record.messageId);
  const messageRole = normalizeMessageRole(record.messageRole);
  const createdAt = normalizeCreatedAt(record.createdAt);
  if (!sessionKey || !messageId || !messageRole || createdAt == null) {
    return null;
  }
  const clientMessageId = normalizeString(record.clientMessageId);
  return {
    kind: "message",
    sessionKey,
    messageId,
    messageRole,
    createdAt,
    ...(clientMessageId ? { clientMessageId } : {}),
  };
}

function buildReferenceContext(
  reference: ClawlineMessageReference,
  messageText: string,
): ClawlineStructuredContextEntry {
  return {
    label: "Referenced message",
    source: "clawline",
    type: "message_reference",
    payload: {
      session_key: reference.sessionKey,
      message_id: reference.messageId,
      client_message_id: reference.clientMessageId,
      message_role: reference.messageRole,
      created_at_ms: reference.createdAt,
      body: messageText,
    },
  };
}

export async function resolveClawlineMessageReferenceContexts(params: {
  references: unknown;
  resolveTranscriptMessages: (
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

    const transcriptMessages = await params.resolveTranscriptMessages(reference.sessionKey);
    if (!transcriptMessages) {
      return {
        ok: false,
        code: "unresolved_reference",
        message: "Referenced message is unavailable.",
      };
    }

    let resolvedText: string | undefined;
    for (const entry of transcriptMessages) {
      if (normalizeString(entry.id) !== reference.messageId) {
        continue;
      }
      if (normalizeMessageRole(entry.message?.role) !== reference.messageRole) {
        continue;
      }
      if (typeof entry.timestamp === "number" && entry.timestamp !== reference.createdAt) {
        continue;
      }
      if (
        reference.clientMessageId &&
        normalizeString(entry.clientMessageId) &&
        normalizeString(entry.clientMessageId) !== reference.clientMessageId
      ) {
        continue;
      }
      resolvedText = extractReadableContent(entry.message?.content);
      if (!resolvedText) {
        continue;
      }
      contexts.push(buildReferenceContext(reference, resolvedText));
      break;
    }

    if (!resolvedText) {
      return {
        ok: false,
        code: "unresolved_reference",
        message: "Referenced message is unavailable.",
      };
    }
  }

  return { ok: true, contexts };
}
