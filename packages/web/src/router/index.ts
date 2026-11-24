import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import type { WebRuntimeConfig } from "../lib/runtime-config";
import { useAuthStore } from "../stores/auth";
import { useRuntimeStore } from "../stores/runtime";

export type HostRoute =
  | true
  | { name: "dashboard" | "login" }
  | "check-session";

/** Where a navigation goes once the host config is known, before asking /api/me. */
export function hostRoute(name: string | symbol | null | undefined, config: WebRuntimeConfig): HostRoute {
  const open = name === "login" || name === "invite";
  if (config.hostMode === "local" && !config.auth.required) {
    return open ? { name: "dashboard" } : true;
  }
  if (config.hostMode === "local" && name === "invite") return { name: "login" };
  if (open) return true;
  return "check-session";
}

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
  const decision = hostRoute(to.name, config);
  if (config.hostMode === "local" && !config.auth.required && !auth.account) {
    auth.account = { username: "local" };
  }
  if (decision !== "check-session") return decision;
  if (auth.account) return true;
  const ok = await auth.fetchMe();
  return ok ? true : { name: "login" };
});
