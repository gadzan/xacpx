import { createApp } from "vue";
import { createPinia } from "pinia";
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
