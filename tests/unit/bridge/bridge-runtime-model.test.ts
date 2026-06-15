import { expect, test } from "bun:test";
import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";

test("prompt injects --model when the session input carries a model", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);

  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "s1", model: "gpt-5.2[high]", text: "hi" });

  const args = calls[0];
  expect(args).toContain("--model");
  expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.2[high]");
  expect(args.indexOf("--model")).toBeLessThan(args.indexOf("prompt"));
});

test("prompt omits --model when no model is set", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);
  await runtime.prompt({ agent: "codex", cwd: "/repo", name: "s1", text: "hi" });
  expect(calls[0]).not.toContain("--model");
});

test("setModel issues `set ... model <id>` with the new model", async () => {
  const calls: string[][] = [];
  const run = async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);

  await runtime.setModel({ agent: "codex", cwd: "/repo", name: "s1", modelId: "claude-opus-4-8" });

  const args = calls[0];
  const setIdx = args.indexOf("set");
  expect(args.slice(setIdx)).toEqual(["set", "-s", "s1", "model", "claude-opus-4-8"]);
  expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-8");
});

test("setModel throws on a non-zero exit", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "requested model unsupported" });
  const runtime = new BridgeRuntime("acpx", run);
  await expect(runtime.setModel({ agent: "codex", cwd: "/repo", name: "s1", modelId: "bogus" })).rejects.toThrow("unsupported");
});

test("getSessionModel parses status json", async () => {
  const run = async (_command: string, args: string[]) => {
    expect(args).toContain("status");
    expect(args.slice(0, 2)).toEqual(["--format", "json"]);
    return { code: 0, stdout: JSON.stringify({ model: "gpt-5.2[high]", availableModels: ["gpt-5.2[high]", "gpt-5.2[low]"] }), stderr: "" };
  };
  const runtime = new BridgeRuntime("acpx", run);
  const result = await runtime.getSessionModel({ agent: "codex", cwd: "/repo", name: "s1" });
  expect(result.current).toBe("gpt-5.2[high]");
  expect(result.available).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
});

test("getSessionModel returns empty available list on non-json output", async () => {
  const run = async () => ({ code: 0, stdout: "not json", stderr: "" });
  const runtime = new BridgeRuntime("acpx", run);
  const result = await runtime.getSessionModel({ agent: "codex", cwd: "/repo", name: "s1" });
  expect(result.available).toEqual([]);
});
