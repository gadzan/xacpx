import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

describe("instances archive actions", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("archiveSession calls control.sessions.archive then reloads", async () => {
    const store = useInstancesStore();
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] } as never);
    await store.archiveSession("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.archive", { alias: "backend" });
  });
  it("unarchiveSession calls control.sessions.unarchive", async () => {
    const store = useInstancesStore();
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] } as never);
    await store.unarchiveSession("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.unarchive", { alias: "backend" });
  });
});
