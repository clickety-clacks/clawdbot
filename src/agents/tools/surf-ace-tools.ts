import { Type } from "@sinclair/typebox";
import type { SurfAceSourceRef, SurfAceWatchDebounce } from "../../clawline/surf-ace.js";
import type { AnyAgentTool } from "./common.js";
import { requireClawlineSurfAceRuntime } from "../../clawline/surf-ace-runtime.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readStringParam } from "./common.js";

const SurfAceContentTypeSchema = stringEnum(["html", "image", "pdf", "terminal", "markdown"]);

const SurfAcePairSchema = Type.Object({
  screen: Type.String({ description: "Surf Ace screen name or fingerprint." }),
});

const SurfAcePushSchema = Type.Object({
  screen: Type.String({ description: "Surf Ace screen name or fingerprint." }),
  contentType: SurfAceContentTypeSchema,
  title: Type.Optional(Type.String()),
  frameId: Type.Optional(Type.String()),
  content: Type.Object({}, { additionalProperties: true }),
  sourceRefSessionKey: Type.Optional(Type.String()),
  sourceRefMessageId: Type.Optional(Type.String()),
});

const SurfAceWatchDebounceSchema = Type.Object({
  scroll_settle: Type.Optional(Type.Number()),
  zoom_settle: Type.Optional(Type.Number()),
  text_selected: Type.Optional(Type.Number()),
  point: Type.Optional(Type.Number()),
  region: Type.Optional(Type.Number()),
  page_change: Type.Optional(Type.Number()),
});

const SurfAceWatchSchema = Type.Object({
  screen: Type.String({ description: "Surf Ace screen name or fingerprint." }),
  enabled: Type.Boolean(),
  debounce: Type.Optional(SurfAceWatchDebounceSchema),
});

const SurfAceClearSchema = Type.Object({
  screen: Type.String({ description: "Surf Ace screen name or fingerprint." }),
});

const SurfAceSnapshotSchema = Type.Object({
  screen: Type.Optional(
    Type.String({
      description: "Optional screen name/fingerprint. Omit to snapshot all paired screens.",
    }),
  ),
});

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

function sourceRefFromArgs(args: Record<string, unknown>): SurfAceSourceRef | undefined {
  const sessionKey =
    typeof args.sourceRefSessionKey === "string" ? args.sourceRefSessionKey.trim() : "";
  const messageId =
    typeof args.sourceRefMessageId === "string" ? args.sourceRefMessageId.trim() : "";
  if (!sessionKey || !messageId) {
    return undefined;
  }
  return { sessionKey, messageId };
}

function debounceFromArgs(args: Record<string, unknown>): SurfAceWatchDebounce | undefined {
  if (!args.debounce || typeof args.debounce !== "object" || Array.isArray(args.debounce)) {
    return undefined;
  }
  const raw = args.debounce as Record<string, unknown>;
  const debounce: SurfAceWatchDebounce = {};
  for (const key of [
    "scroll_settle",
    "zoom_settle",
    "text_selected",
    "point",
    "region",
    "page_change",
  ] as const) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      debounce[key] = value;
    }
  }
  return Object.keys(debounce).length > 0 ? debounce : undefined;
}

type SurfAceToolContext = {
  agentSessionKey?: string;
};

export function createSurfAceTools(context: SurfAceToolContext): AnyAgentTool[] {
  const userId = resolveClawlineUserId(context.agentSessionKey);

  return [
    {
      label: "Surf Ace Pair",
      name: "surf_ace_pair",
      description:
        "Pair with a discovered Surf Ace screen (auto-pairs immediately — no PIN required).",
      parameters: SurfAcePairSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const screen = readStringParam(args, "screen", { required: true });
        const result = await runtime.pair({ userId, screen });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Push",
      name: "surf_ace_push",
      description: "Push a frame to a paired Surf Ace screen.",
      parameters: SurfAcePushSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const screen = readStringParam(args, "screen", { required: true });
        const contentType = readStringParam(args, "contentType", { required: true });
        const title = readStringParam(args, "title");
        const frameId = readStringParam(args, "frameId");
        const content =
          args.content && typeof args.content === "object" && !Array.isArray(args.content)
            ? (args.content as Record<string, unknown>)
            : {};
        const result = await runtime.push({
          userId,
          screen,
          contentType,
          content,
          title,
          frameId,
          sourceRef: sourceRefFromArgs(args),
        });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Watch",
      name: "surf_ace_watch",
      description: "Start or stop watch mode for a Surf Ace screen.",
      parameters: SurfAceWatchSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const screen = readStringParam(args, "screen", { required: true });
        const enabled = typeof args.enabled === "boolean" ? args.enabled : false;
        const result = await runtime.watch({
          userId,
          screen,
          enabled,
          debounce: debounceFromArgs(args),
          watcherSessionKey: context.agentSessionKey,
        });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Clear",
      name: "surf_ace_clear",
      description: "Clear a Surf Ace screen and terminate its active session.",
      parameters: SurfAceClearSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const screen = readStringParam(args, "screen", { required: true });
        const result = await runtime.clear({ userId, screen });
        return jsonResult(result);
      },
    },
    {
      label: "Surf Ace Snapshot",
      name: "surf_ace_snapshot",
      description: "Fetch the current viewport snapshot from one or all paired Surf Ace screens.",
      parameters: SurfAceSnapshotSchema,
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const runtime = requireClawlineSurfAceRuntime();
        const screen = readStringParam(args, "screen");
        const result = await runtime.snapshot({ userId, screen });
        return jsonResult(result);
      },
    },
  ];
}
