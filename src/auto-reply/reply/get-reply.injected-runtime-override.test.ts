import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();
const modelSelection = await import("../../agents/model-selection.js");

vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: mocks.resolveReplyDirectives,
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
}));
vi.mock("./session.js", () => ({
  initSessionState: mocks.initSessionState,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadFreshGetReplyModuleForTest() {
  vi.resetModules();
  ({ getReplyFromConfig } = await import("./get-reply.js"));
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    Body: "test message",
    BodyForAgent: "test message",
    RawBody: "test message",
    CommandBody: "test message",
    SessionKey: "agent:main:clawline:flynn:s_a893994d",
    From: "webchat:user",
    To: "webchat:user",
    ...overrides,
  };
}

describe("getReplyFromConfig injected runtime override", () => {
  beforeEach(async () => {
    await loadFreshGetReplyModuleForTest();
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(modelSelection.resolveModelRefFromString).mockReset();

    mocks.applyMediaUnderstanding.mockResolvedValue(undefined);
    mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
  });

  it("prefers the active runtime model for injected webchat delivery", async () => {
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      },
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:clawline:flynn:s_a893994d",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.4",
      }),
    );
  });

  it("falls back to fallbackNoticeActiveModel when runtime provider/model are absent", async () => {
    vi.mocked(modelSelection.resolveModelRefFromString).mockReturnValue({
      ref: { provider: "openai-codex", model: "gpt-5.4" },
      matchedAlias: undefined,
    });
    mocks.initSessionState.mockResolvedValue({
      sessionCtx: {},
      sessionEntry: {
        fallbackNoticeActiveModel: "openai-codex/gpt-5.4",
      },
      previousSessionEntry: {},
      sessionStore: {},
      sessionKey: "agent:main:clawline:flynn:s_a893994d",
      sessionId: "session-1",
      isNewSession: false,
      resetTriggered: false,
      systemSent: false,
      abortedLastRun: false,
      storePath: "/tmp/sessions.json",
      sessionScope: "per-chat",
      groupResolution: undefined,
      isGroup: false,
      triggerBodyNormalized: "",
      bodyStripped: "",
    });

    await getReplyFromConfig(buildCtx(), undefined, {});

    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        model: "gpt-5.4",
      }),
    );
  });
});
