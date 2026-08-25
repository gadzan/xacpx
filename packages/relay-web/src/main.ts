import { createApp } from "vue";
import { createPinia } from "pinia";
import { registerSW } from "virtual:pwa-register";
import { schedulePwaUpdateChecks } from "./lib/pwa-update";
import App from "./App.vue";
import { router } from "./router";
import { i18n } from "./i18n";
import { useLocaleStore } from "./stores/locale";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./style.css";

const app = createApp(App).use(createPinia()).use(router).use(i18n);
// Instantiate the locale store so the persisted/detected locale is applied to
// i18n before mount (mirrors how the theme store applies on construction).
useLocaleStore();
app.mount("#app");

// Register the service worker (autoUpdate: silently activates the new shell on
// the next navigation). No-ops in dev and where service workers are unsupported
// or the page is not in a secure context (HTTP over LAN). Once registered, poll
// for a new worker on an interval and whenever the tab regains focus, so a tab
// left open picks up a deploy within ~1 minute instead of waiting for a manual
// reload or the browser's ~24h check.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    // Intentionally not torn down: the update schedule should live for the whole
    // page lifetime. onRegisteredSW fires once per registration, so it doesn't stack.
    schedulePwaUpdateChecks(registration);
    // Push-subscription ownership is reconciled by auth.login()/fetchMe() as
    // part of the fail-closed auth contract — NOT here: an unauthenticated
    // page load must not rebind a subscription to an unknown account.
  },
});
