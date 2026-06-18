import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeMode = "dark" | "light";
const KEY = "relay-theme";

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
