import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { agentIconSvg } from "../lib/agent-icons";
import AgentIcon from "../components/AgentIcon.vue";

describe("agentIconSvg", () => {
  it("returns brand SVG markup for known drivers", () => {
    for (const driver of ["codex", "claude", "gemini", "copilot", "cursor", "qwen", "kimi", "opencode"]) {
      const svg = agentIconSvg(driver);
      expect(svg, driver).toBeTruthy();
      expect(svg!).toContain("<svg");
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
});
