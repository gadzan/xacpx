import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createHash } from "node:crypto";
import { agentIconSvg } from "../lib/agent-icons";
import codexRaw from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import claudeRaw from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import geminiRaw from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import copilotRaw from "@lobehub/icons-static-svg/icons/copilot-color.svg?raw";
import cursorRaw from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import hermesRaw from "@lobehub/icons-static-svg/icons/hermesagent.svg?raw";
import qwenRaw from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import kimiRaw from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import opencodeRaw from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import openclawRaw from "@lobehub/icons-static-svg/icons/openclaw-color.svg?raw";
import kilocodeRaw from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kiroRaw from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import qoderRaw from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
import traeRaw from "@lobehub/icons-static-svg/icons/trae-color.svg?raw";
import ompRaw from "../../assets/omp-mark.svg?raw";
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
    // Kiro: the purple rounded-square tile path is gone (its purple now lives on the ghost).
    expect(agentIconSvg("kiro")!).not.toContain('d="M18.8 0H5.2');
    expect((agentIconSvg("kiro")!.match(/<path/g) || []).length).toBe(2);
    // Single-path framed marks must not be stripped.
    expect(agentIconSvg("kilocode")!).toContain("M0 0v24h24V0H0");
  });

  it("fits every mark to ~60% about its ink centroid (Claude included)", () => {
    const parse = (driver: string) => new DOMParser().parseFromString(agentIconSvg(driver)!, "image/svg+xml").documentElement;
    const fit = (driver: string) => {
      const svg = parse(driver);
      const wrappers = [...svg.children].filter((el) => el.tagName === "g");
      expect(wrappers, driver).toHaveLength(1);
      // Everything drawn moves with the wrapper; the viewBox is untouched.
      expect([...svg.children].filter((el) => el.tagName !== "g"), driver).toHaveLength(0);
      const m = wrappers[0]!.getAttribute("transform")!.match(/^translate\((\S+) (\S+)\) scale\((\S+)\) translate\((\S+) (\S+)\)$/);
      expect(m, driver).not.toBeNull();
      return { svg, scale: Number(m![3]), cx: -Number(m![4]), cy: -Number(m![5]) };
    };
    // Codex: tile gone, then scale 0.8 (its >_ mark spans 75% of the box raw).
    expect(fit("codex").scale).toBe(0.8);
    expect(fit("codex").svg.getAttribute("viewBox")).toBe("0 0 24 24");
    // Claude's raw mark spans the full 24-unit width, so long side = 100% x scale.
    const claude = fit("claude");
    expect(claude.scale * 100).toBeGreaterThanOrEqual(55);
    expect(claude.scale * 100).toBeLessThanOrEqual(65);
    expect(claude.scale * 100).toBeCloseTo(60, 0);
    // Its ink centroid sits 0.34px above centre at 32px; the fit moves exactly that point
    // to the viewBox centre.
    expect(claude.cx).toBeCloseTo(12, 2);
    expect(claude.cy).toBeLessThan(12);
    // Kiro's ghost spans 66.2% raw -> ~60% after the fit.
    expect(fit("kiro").scale * 66.2).toBeCloseTo(60, 0);
    for (const driver of ["gemini", "copilot", "cursor", "hermes", "qwen", "kimi", "opencode", "openclaw", "kilocode", "qoder", "trae", "omp"]) fit(driver);
  });

  it("recolours Kiro's ghost to the stripped tile's purple so it shows on light themes", () => {
    const svg = new DOMParser().parseFromString(agentIconSvg("kiro")!, "image/svg+xml").documentElement;
    const fills = [...svg.querySelectorAll("path")].map((el) => el.getAttribute("fill"));
    // Two paths remain after the tile strip: the ghost body and the eyes.
    expect(fills).toEqual(["#9046FF", "#000"]);
    expect(fills).not.toContain("#fff");
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

describe("brand SVG sources", () => {
  // GLYPH_FIT / tile strip / recolour in agent-icons.ts were measured on these exact bytes
  // (@lobehub/icons-static-svg 1.91.0, pinned). An upgrade or edit that changes any glyph
  // fails here: re-measure the marks, update GLYPH_FIT, then update the hash.
  it("match the sha256 the glyph fit was measured on", () => {
    const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
    expect({
      codex: sha(codexRaw), claude: sha(claudeRaw), gemini: sha(geminiRaw), copilot: sha(copilotRaw),
      cursor: sha(cursorRaw), hermes: sha(hermesRaw), qwen: sha(qwenRaw), kimi: sha(kimiRaw),
      opencode: sha(opencodeRaw), openclaw: sha(openclawRaw), kilocode: sha(kilocodeRaw), kiro: sha(kiroRaw),
      qoder: sha(qoderRaw), trae: sha(traeRaw), omp: sha(ompRaw),
    }).toEqual({
      codex: "4a2f43ce46b5b6e3722c95088f88d26ef91e6a8c2e598e70642a1c54367386e4",
      claude: "670b3d8d749d0815ad8f7e62a59d51cb5e2053cb19403f3541a8aed7036a877f",
      gemini: "8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602",
      copilot: "04f15d0556fbac10a4e0f82d1560610db8b33cd04780a4f24ad3b91c4abd278d",
      cursor: "0cb51bddf264ae108926fd554c063ef40fc1aac3c5c921ddb39ad184e4e5d0ef",
      hermes: "02d43c0a91fc2ee41f2684fc39613ff6687de29a4b079665bace5303671dd63b",
      qwen: "77f5768c66d08ce1d3d14e73373975c1bc0454be88c81523ddd0ffd7e2974029",
      kimi: "74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff",
      opencode: "7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302",
      openclaw: "4123c0c75dda5b28e3e0d38075514085bf546178a620776344813c08fa41277c",
      kilocode: "a2aef0e0bb992ebe768bfb8c3a3ab6ff2c2638448b09dd88db27877de1c07a22",
      kiro: "4eae4d6e818da7342c32c7d443ab7c97b93c544db9af379d5b5bf7f0a3127d66",
      qoder: "396596d247477e2a036c141a16ec266df7b14c0130b777a68fd04bc89af50bc8",
      trae: "e7aca314ce71b8fa0a7aece005d585772bac24266fc6688cf398e622d4acaf02",
      omp: "5eade330c3284f7ba72502a31f334a7175032aae1bef6314660130c6a9763d22",
    });
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
