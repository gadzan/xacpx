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

it("points every theme-color meta at the resolved theme on toggle", async () => {
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF">' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#10151C">';
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  const contents = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
  expect(contents()).toEqual(["#10151C", "#10151C"]);
  t.toggle();
  expect(contents()).toEqual(["#FFFFFF", "#FFFFFF"]);
  document.head.innerHTML = "";
});

it("honors a saved preference over the default", async () => {
  localStorage.setItem("relay-theme", "light");
  const { useThemeStore } = await import("../stores/theme");
  const t = useThemeStore();
  expect(t.mode).toBe("light");
});
