import { expect, test } from "bun:test";

import { suiteAlreadyGreen } from "../../../scripts/ci-test-gate.mjs";

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
