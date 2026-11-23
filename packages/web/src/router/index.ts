import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { useRuntimeStore } from "../stores/runtime";

const routes: RouteRecordRaw[] = [
  { path: "/login", name: "login", component: () => import("../views/LoginView.vue") },
  { path: "/invite/:code", name: "invite", component: () => import("../views/InviteView.vue") },
  { path: "/", name: "dashboard", component: () => import("../views/DashboardView.vue") },
  { path: "/settings", name: "settings", component: () => import("../views/SettingsView.vue") },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const runtime = useRuntimeStore();
  const config = await runtime.ensure();
  const auth = useAuthStore();
  const open = to.name === "login" || to.name === "invite";
  if (config.hostMode === "local" && !config.auth.required) {
    if (!auth.account) auth.account = { username: "local" };
    return open ? { name: "dashboard" } : true;
  }
  if (config.hostMode === "local" && to.name === "invite") return { name: "login" };
  if (open) return true;
  if (auth.account) return true;
  const ok = await auth.fetchMe();
  return ok ? true : { name: "login" };
});
