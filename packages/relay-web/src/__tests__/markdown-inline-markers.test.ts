import { describe, expect, it } from "vitest";
import { planInlineActivityMarkers } from "../lib/markdown-inline-markers";

const planAt = (source: string, offset: number, streaming = false) =>
  planInlineActivityMarkers(
    source,
    [{ id: "tool:read-1", offset }],
    {},
    { streaming },
  );

describe("planInlineActivityMarkers", () => {
  it("closes and reopens strong formatting around an activity", () => {
    const source = "Working **carefully now** done";
    const plan = planAt(source, "Working **carefully ".length);

    expect(plan?.activityIds).toEqual(["tool:read-1"]);
    expect(plan?.fragments.map((fragment) => fragment.source)).toEqual([
      "Working **carefully ",
      "now** done",
    ]);
    expect(plan?.fragments[0]!.html).toContain("<strong>carefully </strong>");
    expect(plan?.fragments[1]!.html).toContain("<strong>now</strong> done");
  });

  it("preserves markers while remend heals an incomplete streaming span", () => {
    const source = "Working **carefully now";
    const plan = planAt(source, "Working **carefully ".length, true);

    expect(plan?.activityIds).toEqual(["tool:read-1"]);
    expect(plan?.fragments[0]!.html).toContain("<strong>carefully </strong>");
    expect(plan?.fragments[1]!.html).toContain("<strong>now</strong>");
  });

  it("duplicates a link wrapper when an activity lands in its label", () => {
    const source = "[read the documentation](https://example.com)";
    const plan = planAt(source, "[read the ".length);

    expect(plan?.fragments[0]!.html).toContain('<a href="https://example.com"');
    expect(plan?.fragments[0]!.html).toContain("read the </a>");
    expect(plan?.fragments[1]!.html).toContain("documentation</a>");
  });

  it("splits inline code as code tokens instead of reparsing fragments", () => {
    const source = "`alpha beta`";
    const plan = planAt(source, "`alpha ".length);

    expect(plan?.fragments[0]!.html).toContain("<code>alpha </code>");
    expect(plan?.fragments[1]!.html).toContain("<code>beta</code>");
  });

  it("fails closed when marker injection changes syntax semantics", () => {
    const linkDestination = "[docs](https://example.com)";
    expect(planAt(linkDestination, "[docs](https://exa".length)).toBeNull();

    const delimiter = "before **strong** after";
    expect(planAt(delimiter, "before *".length)).toBeNull();

    const imageLabel = "![alt text](image.png)";
    expect(planAt(imageLabel, "![alt ".length)).toBeNull();
  });

  it("preserves marker and source order for multiple activities at one offset", () => {
    const source = "before after";
    const offset = "before ".length;
    const plan = planInlineActivityMarkers(source, [
      { id: "tool:a", offset },
      { id: "tool:b", offset },
      { id: "tool:c", offset },
    ]);

    expect(plan?.activityIds).toEqual(["tool:a", "tool:b", "tool:c"]);
    expect(plan?.fragments.map((fragment) => fragment.source).join(""))
      .toBe(source);
  });
});
