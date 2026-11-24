import { describe, it, expect, vi, beforeEach } from "vitest";

describe("terminal-font", () => {
  beforeEach(() => {
    document.head.querySelectorAll("style[data-terminal-font]").forEach((n) => n.remove());
    vi.resetModules();
  });

  it("injects the @font-face style exactly once (idempotent)", async () => {
    (document as unknown as { fonts: unknown }).fonts = { load: vi.fn(async () => {}) };
    const mod = await import("../lib/terminal-font");
    await mod.ensureTerminalFont();
    await mod.ensureTerminalFont();
    const styles = document.head.querySelectorAll("style[data-terminal-font]");
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toContain("JetBrainsMono NFM");
    expect(styles[0].textContent).toContain("cdn.jsdmirror.com");
  });

  it("resolves even when document.fonts.load rejects (silent fallback)", async () => {
    (document as unknown as { fonts: unknown }).fonts = {
      load: vi.fn(async () => { throw new Error("blocked"); }),
    };
    const mod = await import("../lib/terminal-font");
    await expect(mod.ensureTerminalFont()).resolves.toBeUndefined();
  });
});
