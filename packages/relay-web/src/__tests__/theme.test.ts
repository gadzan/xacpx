import { setActivePinia, createPinia } from "pinia";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.className = "";
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());

it("defaults to dark and applies the dark class", async () => {
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  expect(t.mode).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("toggle flips the mode, persists it, and updates the class", async () => {
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  t.toggle();
  expect(t.mode).toBe("light");
  expect(localStorage.getItem("relay-theme")).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("honors a saved preference over the default", async () => {
  localStorage.setItem("relay-theme", "light");
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  expect(t.mode).toBe("light");
});
