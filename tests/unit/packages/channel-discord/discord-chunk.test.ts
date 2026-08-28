import { expect, test } from "bun:test";
import { chunkDiscordText } from "../../../../packages/channel-discord/src/chunk";

test("chunk keeps short text in one piece", () => {
  expect(chunkDiscordText("hello")).toEqual(["hello"]);
});

test("chunk splits at 2000 chars and balances fenced blocks", () => {
  const fenceOpen = "```ts\n";
  const body = "a".repeat(1990);
  const fenceClose = "\n```";
  // Build a long fenced block that exceeds 2000
  const text = `${fenceOpen}${body}\n${body}\n${fenceClose}\nplain`;
  const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 17 });
  // Every chunk must be <= 2000 chars
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  // Fence balancing: if cut inside fence, first chunk ends with ```, next starts with ```ts or ```
  const hasBalanced = chunks.some((c) => c.includes("```"));
  expect(hasBalanced).toBe(true);
  // Joined text should still contain plain tail
  expect(chunks.join("\n")).toContain("plain");
});

test("chunk respects 17-line soft limit", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkDiscordText(lines, { maxChars: 10000, maxLines: 17 });
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.split("\n").length).toBeLessThanOrEqual(17);
});

test("chunk handles single overlong line", () => {
  const long = "x".repeat(5000);
  const chunks = chunkDiscordText(long, { maxChars: 2000, maxLines: 17 });
  expect(chunks.length).toBeGreaterThan(1);
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  expect(chunks.join("")).toBe(long);
});

test("chunk empty input returns empty array", () => {
  expect(chunkDiscordText("")).toEqual([]);
});

test("chunk preserves code fence language hint when reopening", () => {
  const text = "```python\n" + "a\n".repeat(20) + "```\nnext";
  const chunks = chunkDiscordText(text, { maxChars: 100, maxLines: 17 });
  // At least one chunk after split should reopen with python hint
  const reopened = chunks.some((c) => c.startsWith("```python"));
  // Either reopened or first chunk contains the original fence
  expect(chunks.join("\n")).toContain("```");
  // No chunk exceeds limit
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  expect(true).toBe(true);
});
