import { expect, test } from "bun:test";
import { resolveOmpRecoveryLaunch } from "../../../src/transport/omp-recovery-launch";

test("OMP recovery retains profile and config while unwrapping the ACP guard", () => {
  expect(resolveOmpRecoveryLaunch({
    agent: "work",
    driver: "omp",
    agentArgv: ["node", "/app/dist/adapters/acp-output-guard-main.js", "--", "/opt/bin/omp", "--profile", "work", "acp", "--config", "/work/config with spaces.yml"],
  })).toEqual({ command: "/opt/bin/omp", args: ["--profile", "work", "--config", "/work/config with spaces.yml"] });
});

test("OMP recovery refuses unknown wrappers and launch flags rather than changing the auth context", () => {
  for (const argv of [["custom-wrapper", "omp", "acp"], ["omp", "acp", "--unknown-profile", "work"], ["omp", "--profile"], ["omp", "acp", "--profile", ""]]) {
    expect(resolveOmpRecoveryLaunch({ agent: "omp", agentArgv: argv })).toBeUndefined();
  }
  expect(resolveOmpRecoveryLaunch({ agent: "codex", agentArgv: ["omp", "acp"] })).toBeUndefined();
});

test("OMP recovery parses quoted historical commands without splitting profile paths", () => {
  expect(resolveOmpRecoveryLaunch({ agent: "omp", rawCommand: '"/Applications/OMP Agent/omp" acp --config="/work/config with spaces.yml" --profile=work' }))
    .toEqual({ command: "/Applications/OMP Agent/omp", args: ["--config=/work/config with spaces.yml", "--profile=work"] });
});
