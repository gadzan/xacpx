import { expect, test, beforeEach } from "bun:test";
import { handleModelShow, handleModelSet } from "../../../../src/commands/handlers/session-handler";
import { setLocale, t } from "../../../../src/i18n";
import type { ResolvedSession } from "../../../../src/transport/types";

beforeEach(() => setLocale("zh"));

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  model: "gpt-5.2[high]",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function makeContext(opts: {
  session?: ResolvedSession | null;
  getModel?: () => Promise<{ current?: string; available: string[] }>;
  setModel?: (s: ResolvedSession, id: string) => Promise<void>;
  calls?: string[];
}) {
  return {
    sessions: {
      getCurrentSession: async () => opts.session ?? null,
      setCurrentSessionModel: async (_chatKey: string, modelId: string) => {
        opts.calls?.push("persist:" + modelId);
      },
    },
    interaction: {
      getModelTransportSession: opts.getModel ?? (async () => ({ available: [] })),
      setModelTransportSession: opts.setModel ?? (async () => {}),
    },
  } as any;
}

test("model show with no current session returns the no-session message", async () => {
  const result = await handleModelShow(makeContext({ session: null }), "wx:a");
  expect(result.text).toBe(t().session.noCurrent);
});

test("model show renders current model and available list", async () => {
  const ctx = makeContext({
    session,
    getModel: async () => ({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] }),
  });
  const result = await handleModelShow(ctx, "wx:a");
  expect(result.text).toContain("gpt-5.2[high]");
  expect(result.text).toContain("gpt-5.2[low]");
});

test("model show falls back to the resolved model when the query throws", async () => {
  const ctx = makeContext({
    session,
    getModel: async () => {
      throw new Error("session not warm");
    },
  });
  const result = await handleModelShow(ctx, "wx:a");
  expect(result.text).toContain("gpt-5.2[high]");
});

test("model set switches the transport model and persists it", async () => {
  const calls: string[] = [];
  const ctx = makeContext({
    session,
    calls,
    setModel: async (_s, id) => {
      calls.push("transport:" + id);
    },
  });
  const result = await handleModelSet(ctx, "wx:a", "claude-opus-4-8");
  expect(calls).toEqual(["transport:claude-opus-4-8", "persist:claude-opus-4-8"]);
  expect(result.text).toBe(t().session.modelSet("claude-opus-4-8"));
});

test("model set surfaces a transport error without persisting", async () => {
  const calls: string[] = [];
  const ctx = makeContext({
    session,
    calls,
    setModel: async () => {
      throw new Error("requested model unsupported");
    },
  });
  const result = await handleModelSet(ctx, "wx:a", "bogus-model");
  expect(calls).toEqual([]); // never persisted
  expect(result.text).toContain("bogus-model");
  expect(result.text).toContain("unsupported");
});
