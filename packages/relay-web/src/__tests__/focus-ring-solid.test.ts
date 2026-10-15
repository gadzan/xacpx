import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Redesign PR2 §3.3: focus/accent rings must be solid accent (translucent rings
// like ring-accent/40 fall below the 3:1 non-text contrast minimum).
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "__tests__" || name === "node_modules") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(vue|ts|css)$/.test(name) ? [p] : [];
  });
}

describe("focus ring tokens", () => {
  it("has no translucent ring-accent/<n> utilities in src", () => {
    const hits = walk(SRC).flatMap((f) =>
      readFileSync(f, "utf8").split("\n").flatMap((line, i) =>
        /ring-accent\/[0-9]+/.test(line) ? [`${f}:${i + 1}`] : []));
    expect(hits).toEqual([]);
  });

  it("form-field focus rule uses a 2px solid accent ring", () => {
    const css = readFileSync(join(SRC, "style.css"), "utf8");
    expect(css).toContain("box-shadow: 0 0 0 2px rgb(var(--c-accent)) !important;");
  });

  it("global field ring excludes data-ring=\"container\" fields", () => {
    const css = readFileSync(join(SRC, "style.css"), "utf8");
    const rule = css.match(/([^{}]*)\{[^}]*box-shadow: 0 0 0 2px rgb\(var\(--c-accent\)\) !important;/);
    expect(rule).not.toBeNull();
    const selectors = rule![1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel).toContain(':not([data-ring="container"])');
    expect(selectors.some((sel) => sel.startsWith("input"))).toBe(true);
    expect(selectors.some((sel) => sel.startsWith("textarea"))).toBe(true);
  });

  it("transparent fields inside ringed containers opt out via data-ring=\"container\"", () => {
    const composer = readFileSync(join(SRC, "components/ConversationComposer.vue"), "utf8");
    const textarea = composer.match(/<textarea[\s\S]*?>/)?.[0] ?? "";
    expect(textarea).toContain('data-ring="container"');
    expect(composer).toContain("focus-within:ring-2 focus-within:ring-accent");

    const palette = readFileSync(join(SRC, "components/CommandPalette.vue"), "utf8");
    const input = palette.match(/<input[^>]*data-test="palette-input"[\s\S]*?>/)?.[0] ?? "";
    expect(input).toContain('data-ring="container"');
  });
});
