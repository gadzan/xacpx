import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useAuthStore } from "../stores/auth";

const routes: RouteRecordRaw[] = [
  { path: "/login", name: "login", component: () => import("../views/LoginView.vue") },
  { path: "/invite/:code", name: "invite", component: () => import("../views/InviteView.vue") },
  { path: "/", name: "dashboard", component: () => import("../views/DashboardView.vue") },
  { path: "/settings", name: "settings", component: () => import("../views/SettingsView.vue") },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  if (to.name === "login" || to.name === "invite") return true;
  const auth = useAuthStore();
  if (auth.account) return true;
  const ok = await auth.fetchMe();
  return ok ? true : { name: "login" };
});
