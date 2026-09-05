import { expect, test, beforeEach } from "bun:test";
import { handleAgentAdd } from "../../../../src/commands/handlers/agent-handler";
import { AsyncMutex } from "../../../../src/orchestration/async-mutex";
import { setLocale } from "../../../../src/i18n";

beforeEach(() => setLocale("zh"));

function makeContext(agents: Record<string, AgentConfig>) {
  const upserts: Array<{ name: string; config: AgentConfig }> = [];
  const config = { agents } as unknown as AppConfig;
  const context = {
    config,
    configStore: {
      upsertAgent: async (name: string, agentConfig: AgentConfig) => {
        upserts.push({ name, config: agentConfig });
        return { ...config, agents: { ...agents, [name]: agentConfig } } as AppConfig;
      },
    },
    replaceConfig: () => {},
    configMutationMutex: new AsyncMutex(),
  } as any;
  return { context, upserts };
}

test("agent add with --model stores the model on a new agent", async () => {
  const { context, upserts } = makeContext({});
  await handleAgentAdd(context, "codex", "gpt-5.2[high]");
  expect(upserts).toHaveLength(1);
  expect(upserts[0].config.model).toBe("gpt-5.2[high]");
  expect(upserts[0].config.driver).toBe("codex");
});

test("agent add without --model stores no model", async () => {
  const { context, upserts } = makeContext({});
  await handleAgentAdd(context, "codex");
  expect(upserts[0].config.model).toBeUndefined();
});

test("agent add --model updates an existing agent's model in place", async () => {
  const { context, upserts } = makeContext({ codex: { driver: "codex" } });
  await handleAgentAdd(context, "codex", "gpt-5.2[low]");
  expect(upserts).toHaveLength(1);
  expect(upserts[0].config.model).toBe("gpt-5.2[low]");
});

test("agent add for an identical existing agent is a no-op", async () => {
  const { context, upserts } = makeContext({ codex: { driver: "codex", model: "gpt-5.2[high]" } });
  await handleAgentAdd(context, "codex", "gpt-5.2[high]");
  expect(upserts).toHaveLength(0);
});

test("plain agent add does not wipe an existing model", async () => {
  const { context, upserts } = makeContext({ codex: { driver: "codex", model: "gpt-5.2[high]" } });
  await handleAgentAdd(context, "codex"); // no --model
  // Either a no-op or an upsert that preserves the model — never a wipe.
  if (upserts.length > 0) {
    expect(upserts[0].config.model).toBe("gpt-5.2[high]");
  }
  expect(context.config.agents.codex.model).toBe("gpt-5.2[high]");
});
