import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeMode = "dark" | "light";
const KEY = "relay-theme";
/** Browser-chrome colour per theme; mirrors --c-bg and the theme-color metas in index.html. */
export const THEME_COLOR: Record<ThemeMode, string> = { light: "#F3F4F6", dark: "#111214" };

function initialMode(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(initialMode());
  function apply() {
    document.documentElement.classList.toggle("dark", mode.value === "dark");
    document.documentElement.style.colorScheme = mode.value;
    // index.html ships one theme-color per prefers-color-scheme; an explicit choice
    // must win over the OS, so point every tag at the resolved theme.
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", THEME_COLOR[mode.value]));
  }
  function set(next: ThemeMode) {
    mode.value = next;
    localStorage.setItem(KEY, next);
    apply();
  }
  function toggle() { set(mode.value === "dark" ? "light" : "dark"); }
  apply();
  return { mode, set, toggle, apply };
});
