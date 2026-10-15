import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { agentIconSvg } from "../lib/agent-icons";
import AgentIcon from "../components/AgentIcon.vue";

describe("agentIconSvg", () => {
  it("returns brand SVG markup for known drivers", () => {
    for (const driver of ["codex", "claude", "gemini", "copilot", "cursor", "hermes", "qwen", "kimi", "opencode", "omp"]) {
      const svg = agentIconSvg(driver);
      expect(svg, driver).toBeTruthy();
      expect(svg!).toContain("<svg");
    }
  });

  it("strips full-bleed solid background tiles (Codex white, Kiro purple)", () => {
    const codex = agentIconSvg("codex")!;
    expect(codex).not.toMatch(/fill="#fff"/i);
    expect(codex).not.toMatch(/fill="#ffffff"/i);
    expect((codex.match(/<path/g) || []).length).toBe(1);
    expect(agentIconSvg("kiro")!).not.toContain("#9046FF");
    // Single-path framed marks must not be stripped.
    expect(agentIconSvg("kilocode")!).toContain("M0 0v24h24V0H0");
  });

  it("fits oversized / off-centre marks with scale-about-centroid (Claude left alone)", () => {
    const parse = (driver: string) => new DOMParser().parseFromString(agentIconSvg(driver)!, "image/svg+xml").documentElement;
    // Codex: white tile gone, then scale 0.8 about its ink centroid.
    const codex = parse("codex");
    const codexG = [...codex.children].filter((el) => el.tagName === "g");
    expect(codexG).toHaveLength(1);
    expect(codexG[0]!.getAttribute("transform")).toMatch(/^translate\(12 12\) scale\(0\.8\) translate\(/);
    expect(codex.getAttribute("viewBox")).toBe("0 0 24 24");
    // Claude already passes size (short side 62.5%) and centroid — no wrapper.
    expect(agentIconSvg("claude")!).not.toContain("<g transform=");
    // Kimi / hermes / omp get a fit wrapper (centroid was outside 0.5px before fit).
    for (const driver of ["kimi", "hermes", "omp", "cursor", "trae"] as const) {
      const svg = parse(driver);
      const wrappers = [...svg.children].filter((el) => el.tagName === "g");
      expect(wrappers, driver).toHaveLength(1);
      expect(wrappers[0]!.getAttribute("transform"), driver).toMatch(/translate\(.+\) scale\(/);
    }
  });

  it("is tolerant of casing and surrounding whitespace", () => {
    expect(agentIconSvg("  CODEX ")).toBe(agentIconSvg("codex"));
  });

  it("returns null for unknown / empty drivers", () => {
    expect(agentIconSvg("totally-made-up")).toBeNull();
    expect(agentIconSvg("")).toBeNull();
    expect(agentIconSvg(null)).toBeNull();
    expect(agentIconSvg(undefined)).toBeNull();
  });
});

describe("AgentIcon", () => {
  it("renders the brand glyph for a known driver", () => {
    const w = mount(AgentIcon, { props: { driver: "codex" } });
    expect(w.find('[data-test="agent-icon"]').exists()).toBe(true);
    expect(w.html()).toContain("<svg");
    // The generic Bot fallback (an <svg> with the lucide class) must not appear.
    expect(w.find(".lucide-bot").exists()).toBe(false);
    // The brand SVG ships at its own 1em size; the inner wrapper (its direct parent) must
    // carry the fill rule so it fills + centers the box. Without it the icon sits off-centre.
    const inner = w.find('[data-test="agent-icon"] > span');
    expect(inner.exists()).toBe(true);
    expect(inner.classes()).toContain("[&>svg]:h-full");
    expect(inner.classes()).toContain("[&>svg]:w-full");
  });

  it("falls back to the generic icon for an unknown driver", () => {
    const w = mount(AgentIcon, { props: { driver: "nope" } });
    expect(w.find('[data-test="agent-icon"]').exists()).toBe(true);
    expect(w.find(".lucide-bot").exists()).toBe(true);
  });

  it("exposes the title for hover discoverability", () => {
    const w = mount(AgentIcon, { props: { driver: "codex", title: "my-codex" } });
    expect(w.find('[data-test="agent-icon"]').attributes("title")).toBe("my-codex");
  });

  it("fills its parent box (no fixed px) when fill is set", () => {
    const w = mount(AgentIcon, { props: { driver: "codex", fill: true } });
    const root = w.find('[data-test="agent-icon"]');
    // Fill mode drops the fixed width/height so the brand tile bleeds to the parent's edges.
    expect(root.classes()).toContain("h-full");
    expect(root.classes()).toContain("w-full");
    expect(root.attributes("style") ?? "").not.toContain("width");
    // The brand SVG still fills + centers.
    const inner = w.find('[data-test="agent-icon"] > span');
    expect(inner.classes()).toContain("[&>svg]:h-full");
    expect(inner.classes()).toContain("[&>svg]:w-full");
  });

  it("keeps a sized, inset glyph for the generic fallback even in fill mode", () => {
    // The line-art Bot would look cramped bleeding edge-to-edge, so it stays at its px size,
    // centered by the parent box's place-items-center.
    const w = mount(AgentIcon, { props: { driver: "nope", fill: true, size: 15 } });
    expect(w.find(".lucide-bot").exists()).toBe(true);
  });
});
