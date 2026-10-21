#!/usr/bin/env node
/**
 * Does this publish job need to run the test suite again?
 *
 * Every publish job runs `npm test` — 488s measured — for a commit that the Test
 * workflow has already covered on its way to main. That duplicate is worth
 * skipping, but only when the same suite has *already* gone green for this exact
 * commit. Everything else answers "run it": red, cancelled, still running, run
 * not found, gh unavailable. That is exactly what the job did before this gate
 * existed, so a flaky Test run can cost the eight minutes and can never block a
 * release.
 *
 * It deliberately does not wait for an in-flight run. Waiting costs a
 * single-package release more than running the suite (the Test job takes ~11 min
 * against the suite's ~8), and only the later tags of a multi-package release
 * can benefit from a skip anyway.
 *
 * Writes `skip=true|false` to $GITHUB_OUTPUT. Outside Actions it just prints.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WORKFLOW = "test.yml";
const JOB = "test";

/**
 * Whether this commit's suite is already provably green.
 *
 * The job name matters: `test` is the ubuntu job that runs the same suite the
 * publish job would. A different job failing (macOS, E2E, windows) is not a
 * reason to re-run this one, and treating it as one would trade a flake for
 * eight minutes of work.
 *
 * @param {{run?:{status?:string}|null, testJob?:{status?:string, conclusion?:string}|null}} input
 * @returns {boolean}
 */
export function suiteAlreadyGreen({ run, testJob }) {
  if (!run || run.status !== "completed") return false;
  if (!testJob) return false;
  return testJob.status === "completed" && testJob.conclusion === "success";
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findRun(sha) {
  const raw = gh([
    "run", "list",
    "--workflow", WORKFLOW,
    "--commit", sha,
    "--limit", "1",
    "--json", "databaseId,status,conclusion,event",
  ]);
  const runs = JSON.parse(raw || "[]");
  // The same commit can carry a pull_request run as well as the push run; the
  // push run is the one that gates main.
  return runs.find((run) => run.event === "push") ?? runs[0] ?? null;
}

function findJob(runId) {
  const raw = gh([
    "api",
    `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}/jobs?per_page=100`,
  ]);
  const jobs = JSON.parse(raw || "{}").jobs ?? [];
  return jobs.find((job) => job.name === JOB) ?? null;
}

async function main() {
  let skip = false;
  let reason = "";
  const sha = process.env.GITHUB_SHA ?? "";
  if (!sha || !process.env.GITHUB_REPOSITORY) {
    reason = "no GITHUB_SHA/GITHUB_REPOSITORY, so this is not a CI run";
  } else {
    try {
      const run = findRun(sha);
      if (!run) {
        reason = `no ${WORKFLOW} run found for ${sha}`;
      } else if (run.status !== "completed") {
        reason = `${WORKFLOW} run for ${sha} is ${run.status}`;
      } else {
        const testJob = findJob(run.databaseId);
        skip = suiteAlreadyGreen({ run, testJob });
        reason = skip
          ? `${WORKFLOW} job "${JOB}" already succeeded for ${sha}`
          : `${WORKFLOW} job "${JOB}" is ${testJob ? `${testJob.status}/${testJob.conclusion}` : "missing"} for ${sha}`;
      }
    } catch (error) {
      reason = `could not read ${WORKFLOW} runs (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  console.log(`${skip ? "skip" : "run"}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`);
}

// Importing this module (for the tests) must not hit the API or write outputs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    // A gate that fails the step would block a release over a metadata lookup.
    // No output means no `skip=true`, so the suite runs.
    console.log(`run: unexpected error (${error instanceof Error ? error.message : String(error)})`);
  });
}
