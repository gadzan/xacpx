import { expect, test } from "bun:test";
import { execSync } from "node:child_process";

function grepCount(pattern: string, path: string): number {
  try {
    const out = execSync(`grep -rn ${JSON.stringify(pattern)} ${path} --include=*.ts`, { encoding: "utf8" });
    return out.trim() ? out.trim().split("\n").length : 0;
  } catch {
    return 0; // grep exits 1 when no match
  }
}

test("no source imports the deleted weixin util/logger singleton", () => {
  expect(grepCount("util/logger", "src")).toBe(0);
});

test("no source writes to the /tmp/openclaw log dir (openclaw-weixin state name is unrelated and allowed)", () => {
  // Guard the LOG DIR literal only. `openclaw-weixin` (state dir / provider id) must stay.
  expect(grepCount('"/tmp", "openclaw"', "src")).toBe(0);
  expect(grepCount("openclaw-${", "src")).toBe(0);
});
