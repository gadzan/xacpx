import { buildApp, resolveRuntimePaths } from "./main";
import type { WechatAgent } from "./wechat-types";

interface DryRunOptions {
  turns: DryRunInputTurn[];
}

interface DryRunInputTurn {
  chatKey: string;
  input: string;
}

interface DryRunTurn {
  input: string;
  output: string;
}

interface DryRunRuntime {
  agent: WechatAgent;
  dispose(): Promise<void>;
}

export function parseDryRunArgs(args: string[]): DryRunOptions {
  let chatKey = "dry-run";
  const turns: DryRunInputTurn[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === "--") {
      continue;
    }
    if (token === "--chat-key") {
      chatKey = args[index + 1] ?? chatKey;
      index += 1;
      continue;
    }

    turns.push({ chatKey, input: token });
  }

  return { turns };
}

export async function runDryRun(agent: WechatAgent, options: DryRunOptions): Promise<DryRunTurn[]> {
  const transcript: DryRunTurn[] = [];

  for (const turn of options.turns) {
    const response = await agent.chat({
      accountId: "dry-run",
      conversationId: turn.chatKey,
      text: turn.input,
      // Declare the chat type explicitly: channel turns without chatType fail
      // closed for privileged commands, and dry-run is always a direct chat.
      metadata: { chatType: "direct" },
    });

    transcript.push({
      input: turn.input,
      output: response.text ?? "",
    });
  }

  return transcript;
}

export async function executeDryRun(runtime: DryRunRuntime, options: DryRunOptions): Promise<DryRunTurn[]> {
  try {
    return await runDryRun(runtime.agent, options);
  } finally {
    await runtime.dispose();
  }
}

async function main(): Promise<void> {
  const options = parseDryRunArgs(process.argv.slice(2));
  if (options.turns.length === 0) {
    throw new Error('Usage: bun run dry-run --chat-key <id> "/session new ..." "hello" [--chat-key <other-id> "/status"]');
  }

  const runtime = await buildApp(resolveRuntimePaths());
  const transcript = await executeDryRun(runtime, options);

  for (const turn of transcript) {
    console.log(`> ${turn.input}`);
    console.log(turn.output);
  }
}

if (import.meta.main) {
  await main();
}
