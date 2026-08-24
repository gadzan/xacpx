import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError, api } from "../api/client";
import { dropAll as dropAllTailCaches } from "../lib/session-tail-cache";
import { dropAll as dropAllViewSnapshots } from "../lib/view-snapshot-cache";
import { releaseSubscriptionOwnership, reconcileExistingSubscription } from "../lib/web-push";

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
      // Ownership transfer is part of the auth contract and MUST complete (or
      // have destroyed the local subscription) before we report success —
      // otherwise a crashed tab's stale binding could leak the previous
      // account's notifications to this one.
      await reconcileExistingSubscription();
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
      // Page reload with a live session: same fail-closed ownership-transfer
      // contract as login().
      await reconcileExistingSubscription();
      return true;
    } catch {
      account.value = null;
      return false;
    }
  }

  async function logout(): Promise<void> {
    // Release the browser↔account push binding BEFORE /api/logout clears the
    // session cookie: after it, the hub would reject the DELETE as 401 and the
    // endpoint would keep pointing at this account for anyone logging in next.
    await releaseSubscriptionOwnership();
    await api.post("/api/logout").catch(() => {});
    account.value = null;
    // Shared-machine hygiene: the next login must not be able to read cached
    // transcripts or view snapshots from IndexedDB.
    await Promise.all([dropAllTailCaches(), dropAllViewSnapshots()]);
  }

  return { account, error, login, fetchMe, logout };
});
