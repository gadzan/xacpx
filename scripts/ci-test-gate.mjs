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

/**
 * The commit this job is actually publishing.
 *
 * Not `GITHUB_SHA`: a `workflow_dispatch` with `inputs.tag` checks that tag out
 * — the workflows do `ref: ${{ inputs.tag || github.ref }}` — while GITHUB_SHA
 * stays on the ref the dispatch was started from, which is main's HEAD. Reading
 * it would let the gate vouch for a commit other than the one being published,
 * and that is the single failure this gate must never have. A failure to resolve
 * answers "run it", like every other unknown.
 *
 * @param {(file:string, args:string[], options:object)=>string} [run]
 * @returns {string}
 */
export function resolveHeadSha(run = execFileSync) {
  try {
    return run("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function findRun(sha) {
  // The filters belong in the query, not in a `find()` afterwards: `--limit 1`
  // would leave a single candidate, so a later `?? runs[0]` would accept
  // whatever it got. A pull_request run cannot vouch for this commit either —
  // it tests the synthetic merge commit, not the branch head being published.
  const raw = gh([
    "run", "list",
    "--workflow", WORKFLOW,
    "--commit", sha,
    "--event", "push",
    "--branch", "main",
    "--limit", "1",
    "--json", "databaseId,status,conclusion",
  ]);
  return JSON.parse(raw || "[]")[0] ?? null;
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
  const sha = resolveHeadSha();
  if (!process.env.GITHUB_REPOSITORY) {
    reason = "no GITHUB_REPOSITORY, so this is not a CI run";
  } else if (!sha) {
    reason = "could not resolve the checked-out commit";
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
