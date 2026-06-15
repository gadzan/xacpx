import { expect, test } from "bun:test";
import { parseCommand } from "../../../src/commands/parse-command";

test("/session new parses an optional --model flag", () => {
  const cmd = parseCommand("/session new api-fix --agent codex --ws backend --model gpt-5.2[high]");
  expect(cmd).toEqual({ kind: "session.new", alias: "api-fix", agent: "codex", workspace: "backend", model: "gpt-5.2[high]" });
});

test("/session new without --model omits the model field", () => {
  const cmd = parseCommand("/session new api-fix --agent codex --ws backend");
  expect(cmd).toEqual({ kind: "session.new", alias: "api-fix", agent: "codex", workspace: "backend" });
});

test("/session new accepts the -m short flag", () => {
  const cmd = parseCommand("/session new api-fix -a codex -ws backend -m claude-opus-4-8");
  expect(cmd).toMatchObject({ kind: "session.new", model: "claude-opus-4-8" });
});

test("/agent add parses an optional --model flag", () => {
  expect(parseCommand("/agent add codex --model gpt-5.2[high]")).toEqual({ kind: "agent.add", template: "codex", model: "gpt-5.2[high]" });
  expect(parseCommand("/agent add codex")).toEqual({ kind: "agent.add", template: "codex" });
});

test("/model with no argument is a show command", () => {
  expect(parseCommand("/model")).toEqual({ kind: "model.show" });
});

test("/model <id> is a set command", () => {
  expect(parseCommand("/model gpt-5.2[high]")).toEqual({ kind: "model.set", modelId: "gpt-5.2[high]" });
});
