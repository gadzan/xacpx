import { expect, test, describe } from "bun:test";
import { renderDiscordMarkdown } from "../../../../packages/channel-discord/src/markdown";

describe("renderDiscordMarkdown", () => {
  test("tableMode code wraps table in fence", () => {
    const input = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const out = renderDiscordMarkdown(input, "code");
    expect(out).toContain("```");
    expect(out).toContain("| a | b |");
  });

  test("tableMode bullets converts to bullet lines", () => {
    const input = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    const out = renderDiscordMarkdown(input, "bullets");
    expect(out).toContain("- a: 1 \u00b7 b: 2");
    expect(out).toContain("- a: 3 \u00b7 b: 4");
    expect(out).not.toContain("```");
  });

  test("tableMode off leaves pipes as-is", () => {
    const input = ["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    expect(renderDiscordMarkdown(input, "off")).toBe(input);
  });

  test("fenced code blocks protect tables and H1", () => {
    const input = ["```", "# not a heading", "| a | b |", "```", "# real", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const out = renderDiscordMarkdown(input, "code");
    expect(out).toContain("# not a heading");
    expect(out).not.toContain("## not a heading");
    expect(out).toContain("## real");
    expect(out).toContain("```");
  });

  test("H1 inside fence is not downgraded (S7)", () => {
    const input = ["```", "# comment", "```", "# title"].join("\n");
    const out = renderDiscordMarkdown(input, "off");
    expect(out.split("\n")[1]).toBe("# comment");
    expect(out).toContain("## title");
  });

  test("fail-safe returns original on weird input", () => {
    expect(renderDiscordMarkdown("", "code")).toBe("");
    expect(renderDiscordMarkdown("| single line |", "code")).toContain("| single line |");
  });
});
