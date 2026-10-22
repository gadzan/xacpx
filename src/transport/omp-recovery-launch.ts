import { splitAdapterCommand } from "../adapters/adapter-catalog";
import { unwrapAcpOutputGuardArgv } from "../adapters/acp-output-guard";

export function resolveOmpRecoveryLaunch(input: {
  agent: string;
  driver?: string;
  agentArgv?: string[];
  agentCommand?: string;
  rawCommand?: string;
}): { command: string; args: string[] } | undefined {
  if ((input.driver ?? input.agent) !== "omp") return undefined;
  const raw = input.rawCommand ?? input.agentCommand;
  const argv = unwrapAcpOutputGuardArgv(
    input.agentArgv ?? (raw ? splitAdapterCommand(raw) ?? [] : ["omp", "acp"]),
  );
  const command = argv[0];
  if (!command || !/^omp(?:\.exe|\.cmd)?$/i.test(command.replaceAll("\\", "/").split("/").at(-1)!)) {
    return undefined;
  }
  const args: string[] = [];
  let acp = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "acp" && !acp) {
      acp = true;
    } else if (arg === "--profile" || arg === "--config" || arg === "--plugin-dir" || arg === "--extension" || arg === "-e") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) return undefined;
      args.push(arg, value);
    } else if (/^--(?:profile|config|plugin-dir|extension)=.+$/.test(arg)) {
      args.push(arg);
    } else if (["--no-extensions", "--no-skills", "--no-rules"].includes(arg)) {
      args.push(arg);
    } else {
      return undefined;
    }
  }
  return acp ? { command, args } : undefined;
}
