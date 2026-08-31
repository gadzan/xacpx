import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static guard for the publish workflow. The failure this prevents is a
// supply-chain one: `actions/checkout` accepts a branch name wherever a tag is
// expected, so a manual run pointed at a branch (or a tag whose name does not
// match the package it just built) would publish that tree under a release tag.
// A static test is enough here because the invariant is "this gate exists in the
// workflow that runs on publish" — the gate's own logic is plain shell.

const workflowPath = resolve(import.meta.dir, "../../../.github/workflows/publish-channel-discord.yml");
const workflow = readFileSync(workflowPath, "utf8");

/** Every line of shell text in the workflow: block-scalar bodies and inline values. */
function shellLines(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let blockIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (trimmed.length === 0 || indent > blockIndent) {
        out.push(line);
        continue;
      }
      blockIndent = -1;
    }
    const block = /^(\s*)(?:-\s+)?run:\s*\|\s*$/.exec(line);
    if (block) {
      blockIndent = block[1]!.length;
      continue;
    }
    const inline = /^\s*(?:-\s+)?run:\s*(\S.*)$/.exec(line);
    if (inline) out.push(inline[1]!);
  }
  return out;
}

test("a manual run checks out the tag ref, never a branch-shaped input", () => {
  expect(workflow).toContain("ref: refs/tags/${{ inputs.tag }}");
  expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
  // The tag-push trigger gets its own checkout, so the two provenance paths
  // cannot be collapsed into one `inputs.tag || github.ref` fallback that
  // silently accepts anything.
  expect(workflow).toContain("if: github.event_name == 'push'");
  expect(workflow).toContain("ref: ${{ github.ref }}");
  expect(workflow).not.toContain("ref: ${{ inputs.tag || github.ref }}");
});

test("tag provenance is verified before anything is published", () => {
  const showRef = workflow.indexOf('git show-ref --verify --quiet "refs/tags/$TAG_NAME"');
  const tagCommit = workflow.indexOf('git rev-parse "refs/tags/$TAG_NAME^{commit}"');
  const headCommit = workflow.indexOf('git rev-parse HEAD');
  const versionMatch = workflow.indexOf('EXPECTED="channel-discord-v${PACKAGE_VERSION}"');
  const publish = workflow.indexOf("npm publish");

  expect(showRef).toBeGreaterThan(-1);
  expect(tagCommit).toBeGreaterThan(-1);
  expect(headCommit).toBeGreaterThan(-1);
  expect(versionMatch).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(-1);
  // Order is the whole point: a tag that exists, that points at HEAD, and whose
  // name carries the built version — all three, before `npm publish` runs.
  expect(showRef).toBeLessThan(tagCommit);
  expect(tagCommit).toBeLessThan(headCommit);
  expect(headCommit).toBeLessThan(versionMatch);
  expect(versionMatch).toBeLessThan(publish);
  expect(workflow).toContain('if [[ "$TAG_COMMIT" != "$HEAD_COMMIT" ]]; then');
  expect(workflow).toContain('if [[ "$TAG_NAME" != "$EXPECTED" ]]; then');
});

test("the release is created with --verify-tag on both the prerelease and stable path", () => {
  const creates = workflow.split("\n").filter((line) => line.includes("gh release create"));
  expect(creates.length).toBe(2);
  for (const line of creates) {
    expect(line).toContain('gh release create "$TAG_NAME" --verify-tag');
  }
});

test("no workflow expression is interpolated into shell", () => {
  // Prove the scanner sees shell text at all, otherwise the assertion below
  // would pass on a broken scanner and a workflow with interpolation.
  const shell = shellLines(workflow).join("\n");
  expect(shell).toContain("git show-ref --verify");
  expect(shell).toContain("npm publish --tag");
  const polluted = workflow + '\n      - name: rogue\n        run: |\n          echo "${{ inputs.tag }}"\n';
  expect(shellLines(polluted).filter((line) => line.includes("${{")).length).toBe(1);

  const offenders = shellLines(workflow).filter((line) => line.includes("${{"));
  expect(offenders).toEqual([]);
  // Values reach the shell through env, which is what makes the above safe.
  expect(workflow).toContain("DISPATCH_TAG: ${{ inputs.tag }}");
  expect(workflow).toContain("TAG_NAME: ${{ steps.meta.outputs.tag_name }}");
  expect(workflow).toContain("NPM_TAG: ${{ steps.meta.outputs.npm_tag }}");
  expect(workflow).not.toContain('TAG_NAME="${{ inputs.tag }}"');
});
