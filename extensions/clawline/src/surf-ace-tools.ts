import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { requireClawlineSurfAceRuntime } from "./surf-ace-runtime.js";

type SurfAceToolContext = {
  sessionKey?: string;
  messageChannel?: string;
};

const SurfAceListSchema = Type.Object({});

const SurfAcePushSchema = Type.Object({
  fingerprint: Type.String({ description: "Surf Ace screen fingerprint (pk prefix)." }),
  contentType: Type.String({
    description: "Content type.",
    enum: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
  }),
  content: Type.String({
    description:
      "Content payload string. html/terminal/markdown use UTF-8 text; image/pdf use base64; video uses URL; canvas uses JSON background spec or empty string.",
  }),
});

const SurfAceClearSchema = Type.Object({
  fingerprint: Type.String({ description: "Surf Ace screen fingerprint (pk prefix)." }),
});

const SurfAceReadSchema = Type.Object({
  fingerprint: Type.String({ description: "Surf Ace screen fingerprint (pk prefix)." }),
});

const SurfAceAnnotationsRemoveSchema = Type.Object({
  fingerprint: Type.String({ description: "Surf Ace screen fingerprint (pk prefix)." }),
  contentId: Type.String({ description: "Active contentId on the target screen." }),
  strokeIds: Type.Array(Type.String(), { minItems: 1 }),
});

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts: { required?: boolean } = {},
): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (opts.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    if (opts.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  return value;
}

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function isClawlineToolContext(context: SurfAceToolContext): boolean {
  if (context.messageChannel?.toLowerCase() === "clawline") {
    return true;
  }
  return context.sessionKey?.toLowerCase().includes(":clawline:") === true;
}

function resolveClawlineUserId(sessionKey: string | undefined): string | null {
  if (!sessionKey) {
    return null;
  }
  const parts = sessionKey.split(":");
  if (parts.length < 5) {
    return null;
  }
  if (parts[0]?.toLowerCase() !== "agent" || parts[2]?.toLowerCase() !== "clawline") {
    return null;
  }
  const userId = parts[3]?.trim();
  return userId ? userId : null;
}

export function createSurfAceTools(params: { context: SurfAceToolContext }): AnyAgentTool[] {
  const { context } = params;
  if (!isClawlineToolContext(context)) {
    return [];
  }

  const userId = resolveClawlineUserId(context.sessionKey);

  return [
    {
      label: "Surf Ace List",
      name: "surf_ace_list",
      description: "List known Surf Ace screens and local cached state.",
      parameters: SurfAceListSchema,
      execute: async () => {
        const runtime = requireClawlineSurfAceRuntime();
        const result = await runtime.list({ userId });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Push",
      name: "surf_ace_push",
      description: "Push content to a Surf Ace screen.",
      parameters: SurfAcePushSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const fingerprint = readStringParam(args, "fingerprint", { required: true });
        const contentType = readStringParam(args, "contentType", { required: true });
        const content = readStringParam(args, "content", { required: true });
        const result = await runtime.push({
          userId,
          fingerprint: fingerprint as string,
          contentType: contentType as string,
          content: content as string,
        });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Clear",
      name: "surf_ace_clear",
      description: "Clear active content on a Surf Ace screen.",
      parameters: SurfAceClearSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const fingerprint = readStringParam(args, "fingerprint", { required: true });
        const result = await runtime.clear({ userId, fingerprint: fingerprint as string });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Read",
      name: "surf_ace_read",
      description: "Read Surf Ace local event buffer for a screen (local only).",
      parameters: SurfAceReadSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const fingerprint = readStringParam(args, "fingerprint", { required: true });
        const result = await runtime.read({ userId, fingerprint: fingerprint as string });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Annotations Remove",
      name: "surf_ace_annotations_remove",
      description: "Remove specific Surf Ace annotation strokes by strokeId.",
      parameters: SurfAceAnnotationsRemoveSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const fingerprint = readStringParam(args, "fingerprint", { required: true });
        const contentId = readStringParam(args, "contentId", { required: true });
        const strokeIds = Array.isArray(args.strokeIds)
          ? args.strokeIds
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : [];
        if (strokeIds.length === 0) {
          throw new Error("strokeIds required");
        }
        const result = await runtime.annotationsRemove({
          userId,
          fingerprint: fingerprint as string,
          contentId: contentId as string,
          strokeIds,
        });
        return jsonResult(result);
      },
    },
  ];
}
