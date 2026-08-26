#!/usr/bin/env node
// G13 gate (plan §61): xacpx source may import ONLY "acpx/runtime", and ONLY
// from src/bridge/engine/runtime/runtime-adapter.ts. Anything else — acpx/dist/*,
// acpx/src/*, or a bare "acpx" — fails the check with a file:line list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const ALLOWED_FILE = join(ROOT, "bridge/engine/runtime/runtime-adapter.ts");
const ALLOWED_SPEC = "acpx/runtime";

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (full.endsWith(".ts")) {
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, idx) => {
        const match = line.match(/from\s+["'](acpx[^"']*)["']/);
        if (!match) return;
        const spec = match[1];
        if (spec === ALLOWED_SPEC && full === ALLOWED_FILE) return;
        violations.push(`${full}:${idx + 1}: imports "${spec}"`);
      });
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error("acpx import policy violated (only runtime-adapter.ts may import 'acpx/runtime'):");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("acpx import policy OK");
