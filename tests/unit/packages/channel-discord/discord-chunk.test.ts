import { expect, test } from "bun:test";
import { chunkDiscordText } from "../../../../packages/channel-discord/src/chunk";

/** Review #4: every emitted chunk must be independently fence-balanced —
 *  an even number of fence-marker lines and never an isolated "```". */
function assertChunksFenceBalanced(chunks: string[]): void {
  for (const chunk of chunks) {
    expect(chunk.trim()).not.toBe("```");
    const fenceLines = chunk.match(/^```/gm)?.length ?? 0;
    expect(fenceLines % 2).toBe(0);
  }
}

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
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
  assertChunksFenceBalanced(chunks);
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
  expect(chunks.some((c) => c.startsWith("```python"))).toBe(true);
  expect(chunks.join("\n")).toContain("next");
  // No chunk exceeds limit; every chunk stays fence-balanced
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  assertChunksFenceBalanced(chunks);
});

test("chunk keeps closing fence with preceding 16-line body at maxLines boundary (review #4)", () => {
  const text = "```ts\n" + Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n") + "\n```\nnext";
  const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 17 });
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.startsWith("```ts")).toBe(true);
  expect(chunks[0]!.endsWith("```")).toBe(true);
  expect(chunks[1]).toBe("next");
  assertChunksFenceBalanced(chunks);
});

test("chunk keeps 15-line fenced block intact under maxLines=17 (review #4)", () => {
  const text = "```ts\n" + Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") + "\n```\nnext";
  const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 17 });
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.startsWith("```ts")).toBe(true);
  expect(chunks[0]!.endsWith("```")).toBe(true);
  assertChunksFenceBalanced(chunks);
});

test("chunk stays fence-balanced when char limit splits just before the closing fence (review #4)", () => {
  const text = "```ts\n" + "x".repeat(40) + "\n```\nafter";
  const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 17 });
  expect(chunks.length).toBe(2);
  expect(chunks[0]!.endsWith("```")).toBe(true);
  expect(chunks[1]).toBe("after");
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
  assertChunksFenceBalanced(chunks);
});
