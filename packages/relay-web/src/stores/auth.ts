import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../api/client";
import { dropAll as dropAllTailCaches } from "../lib/session-tail-cache";

export interface Account {
  username: string;
}

export const useAuthStore = defineStore("auth", () => {
  const account = ref<Account | null>(null);
  const error = ref("");

  async function login(token: string): Promise<boolean> {
    error.value = "";
    try {
      account.value = await api.post<Account>("/api/login", { token });
      return true;
    } catch (e) {
      error.value = e instanceof ApiError ? e.code : "request-failed";
      account.value = null;
      return false;
    }
  }

  async function fetchMe(): Promise<boolean> {
    try {
      account.value = await api.get<Account>("/api/me");
      return true;
    } catch {
      account.value = null;
      return false;
    }
  }

  async function logout(): Promise<void> {
    await api.post("/api/logout").catch(() => {});
    account.value = null;
    // Shared-machine hygiene: the next login must not be able to read cached
    // transcripts from IndexedDB (spec #205 user story 5).
    await dropAllTailCaches();
  }

  return { account, error, login, fetchMe, logout };
});
