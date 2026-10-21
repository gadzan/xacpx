import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHeadSha, suiteAlreadyGreen } from "../../../scripts/ci-test-gate.mjs";

const completed = { status: "completed", conclusion: "success" };

test("skips only when the same suite already passed for this commit", () => {
  expect(suiteAlreadyGreen({
    run: { status: "completed", conclusion: "success" },
    testJob: completed,
  })).toBe(true);
});

test("runs the suite for every state that is not proof", () => {
  // Red is the flake case: the publish job then runs the suite itself, which is
  // exactly what it did before this gate existed, so a flaky Test run can cost
  // the time but cannot block a release.
  expect(suiteAlreadyGreen({
    run: { status: "completed", conclusion: "failure" },
    testJob: { status: "completed", conclusion: "failure" },
  })).toBe(false);
  // Still running, cancelled or skipped: nothing has been proven.
  expect(suiteAlreadyGreen({ run: { status: "in_progress" }, testJob: null })).toBe(false);
  expect(suiteAlreadyGreen({
    run: { status: "completed" },
    testJob: { status: "completed", conclusion: "cancelled" },
  })).toBe(false);
  // No job of that name, and no run at all.
  expect(suiteAlreadyGreen({ run: { status: "completed" }, testJob: null })).toBe(false);
  expect(suiteAlreadyGreen({ run: null, testJob: null })).toBe(false);
});

test("a different job failing does not force this suite to run again", () => {
  // The Test workflow also carries macOS, E2E and windows jobs. Re-running the
  // ubuntu suite because one of those flaked would trade a flake for eight
  // minutes of work without proving anything new.
  expect(suiteAlreadyGreen({
    run: { status: "completed", conclusion: "failure" },
    testJob: completed,
  })).toBe(true);
});

const GATE = join(import.meta.dir, "../../../scripts/ci-test-gate.mjs");

/**
 * Runs the real CLI against a fake `gh` on PATH. The arguments it sends are part
 * of the promise — they decide which commit gets vouched for — so they are
 * asserted rather than mocked away.
 */
function runGate({ cwd, runs = [], jobs = [], env = {} }: {
  cwd: string;
  runs?: unknown[];
  jobs?: unknown[];
  env?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-test-gate-"));
  const log = join(dir, "gh-args.log");
  const runsFile = join(dir, "runs.json");
  const jobsFile = join(dir, "jobs.json");
  const out = join(dir, "output");
  writeFileSync(log, "");
  writeFileSync(out, "");
  writeFileSync(runsFile, JSON.stringify(runs));
  writeFileSync(jobsFile, JSON.stringify({ jobs }));
  const gh = join(dir, "gh");
  writeFileSync(gh, [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    `if [ "$1" = "api" ]; then cat ${JSON.stringify(jobsFile)}; else cat ${JSON.stringify(runsFile)}; fi`,
    "",
  ].join("\n"));
  chmodSync(gh, 0o755);
  execFileSync("node", [GATE], {
    cwd,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: out,
      GITHUB_REPOSITORY: "gadzan/xacpx",
      ...env,
    },
  });
  const calls = readFileSync(log, "utf8").trim();
  return { skip: readFileSync(out, "utf8").trim(), calls: calls ? calls.split("\n") : [] };
}

const greenRun = [{ databaseId: 7, status: "completed", conclusion: "success" }];
const greenJob = [{ name: "test", status: "completed", conclusion: "success" }];

// The checkout stands in for the tag a manual dispatch would check out: its
// HEAD is a real commit, which is the whole point of the assertion below.
const REPO_ROOT = join(import.meta.dir, "../../..");

// Process spawns cost ~1s each on some developer machines; the assertions are
// about arguments, not speed.
const SPAWN_TIMEOUT = 30_000;

test("queries the commit that was checked out, not the ref the dispatch started from", () => {
  // A manual dispatch with `inputs.tag` checks out that tag while GITHUB_SHA
  // stays on main's HEAD. Reading GITHUB_SHA would let the gate vouch for a
  // commit other than the one being published.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const dispatchRef = "d".repeat(40);
  const { skip, calls } = runGate({
    cwd: REPO_ROOT,
    env: { GITHUB_SHA: dispatchRef },
    runs: greenRun,
    jobs: greenJob,
  });
  expect(skip).toBe("skip=true");
  expect(calls[0]).toContain(`--commit ${head}`);
  expect(calls[0]).not.toContain(dispatchRef);
  expect(calls[1]).toContain("/actions/runs/7/jobs");
}, SPAWN_TIMEOUT);

test("only a push run on main can vouch for a commit", () => {
  // A pull_request run tests the synthetic merge commit, so it proves nothing
  // about the branch head being published. The constraint has to be in the
  // query: a `find()` after `--limit 1` has nothing to choose from.
  const { skip, calls } = runGate({ cwd: REPO_ROOT, runs: [], jobs: [] });
  expect(calls[0]).toContain("--event push");
  expect(calls[0]).toContain("--branch main");
  expect(skip).toBe("skip=false");
}, SPAWN_TIMEOUT);

test("an unresolvable commit runs the suite instead of loading the API", () => {
  const { skip, calls } = runGate({ cwd: mkdtempSync(join(tmpdir(), "ci-test-gate-")), runs: greenRun, jobs: greenJob });
  expect(skip).toBe("skip=false");
  expect(calls).toEqual([]);
  expect(resolveHeadSha(() => {
    throw new Error("not a git repo");
  })).toBe("");
}, SPAWN_TIMEOUT);

test("a tag from before this gate still runs its tests", () => {
  // Re-dispatching an old tag checks out a tree without this script, so the
  // step cannot even start. It must never be what blocks the release: no output
  // means no `skip=true`, and `continue-on-error` keeps the job alive.
  const dir = join(import.meta.dir, "../../../.github/workflows");
  const files = readdirSync(dir).filter((file) => file.startsWith("publish-") && file.endsWith(".yml"));
  expect(files.length).toBeGreaterThanOrEqual(7);
  for (const file of files) {
    const yaml = readFileSync(join(dir, file), "utf8");
    expect({ file, guarded: yaml.includes("continue-on-error: true") }).toEqual({ file, guarded: true });
    expect({ file, gated: yaml.includes("if: steps.test-gate.outputs.skip != 'true'") }).toEqual({ file, gated: true });
  }
});
