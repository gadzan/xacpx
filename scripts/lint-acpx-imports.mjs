#!/usr/bin/env node
// G13 gate (plan §61): xacpx source may import ONLY "acpx/runtime", and ONLY
// from src/bridge/engine/runtime/runtime-adapter.ts. Anything else — acpx/dist/*,
// acpx/src/*, or a bare "acpx" — fails the check with a file:line list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// URL.pathname on Windows yields "/D:/..." which path.join mangles into
// "D:\D:\..." — always convert through fileURLToPath for a real platform path.
const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED_FILE = join(ROOT, "bridge/engine/runtime/runtime-adapter.ts");
// Legacy lazy require for install-hint flows; Wave B folds it into the adapter.
const ALLOWED_LAZY_FILES = new Set([join(ROOT, "transport/agent-registry.ts")]);
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
        // Static: from "acpx..." — dynamic: import("acpx...") / require("acpx...")
        const matches = [
          line.match(/from\s+["'](acpx[^"']*)["']/),
          line.match(/import\(\s*["'](acpx[^"']*)["']\s*\)/),
          line.match(/require\(\s*["'](acpx[^"']*)["']\s*\)/),
        ].filter(Boolean);
        for (const match of matches) {
          const spec = match[1];
          if (spec === ALLOWED_SPEC && full === ALLOWED_FILE) continue;
          if (spec === ALLOWED_SPEC && ALLOWED_LAZY_FILES.has(full)) continue;
          violations.push(`${full}:${idx + 1}: imports "${spec}"`);
        }
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
