import { defineStore } from "pinia";
import { ref } from "vue";
import { i18n, resolveLocale, SUPPORTED_LOCALES, type AppLocale } from "../i18n";

const KEY = "relay-locale";

function initialLocale(): AppLocale {
  const saved = localStorage.getItem(KEY);
  if (saved && (SUPPORTED_LOCALES as readonly string[]).includes(saved)) {
    return saved as AppLocale;
  }
  return resolveLocale(navigator?.language);
}

export const useLocaleStore = defineStore("locale", () => {
  const locale = ref<AppLocale>(initialLocale());
  function apply() {
    i18n.global.locale.value = locale.value;
    document.documentElement.lang = locale.value;
  }
  function set(next: AppLocale) {
    locale.value = next;
    localStorage.setItem(KEY, next);
    apply();
  }
  apply();
  return { locale, set };
});
