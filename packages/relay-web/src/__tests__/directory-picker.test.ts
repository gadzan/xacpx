import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DirectoryPicker from "../components/DirectoryPicker.vue";
import { api } from "../api/client";
import { i18n } from "../i18n";

type Browse = {
  path: string; sep: "/" | "\\"; parent: string | null; home: string;
  dirs: Array<{ name: string; path: string }>; truncated: boolean;
};
const home: Browse = {
  path: "/home/me", sep: "/", parent: "/home", home: "/home/me",
  dirs: [
    { name: "proj", path: "/home/me/proj" },
    { name: ".config", path: "/home/me/.config" },
  ],
  truncated: false,
};

function mountPicker(initialPath?: string) {
  return mount(DirectoryPicker, {
    props: { instanceId: "i1", ...(initialPath ? { initialPath } : {}) },
    global: { stubs: { teleport: true } },
  });
}

describe("DirectoryPicker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("loads home on mount when no initialPath", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", {});
    expect((w.get('[data-test="dp-path"]').element as HTMLInputElement).value).toBe("/home/me");
  });

  it("navigates into a directory on row click", async () => {
    const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      return (path === "/home/me/proj"
        ? { ...home, path: "/home/me/proj", parent: "/home/me", dirs: [{ name: "src", path: "/home/me/proj/src" }] }
        : home) as never;
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-dir-proj"]').trigger("click");
    await flushPromises();
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "/home/me/proj" });
    expect(w.find('[data-test="dp-dir-src"]').exists()).toBe(true);
  });

  it("hides dot-directories until toggled", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    expect(w.find('[data-test="dp-dir-.config"]').exists()).toBe(false);
    await w.get('[data-test="dp-show-hidden"]').setValue(true);
    expect(w.find('[data-test="dp-dir-.config"]').exists()).toBe(true);
  });

  it("confirm emits the current absolute path and closes", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-confirm"]').trigger("click");
    expect(w.emitted("confirm")).toEqual([["/home/me"]]);
    expect(w.emitted("close")).toBeTruthy();
  });

  it("up button navigates to parent; home button to home", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ ...home, path: "/home/me/proj", parent: "/home/me" } as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-up"]').trigger("click");
    await w.get('[data-test="dp-home"]').trigger("click");
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", { path: "/home/me" });
  });

  it("path input Enter navigates to the typed path", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/srv");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "/srv" });
  });

  it("discards a stale response that resolves after a newer navigation", async () => {
    let resolveFirst!: (v: unknown) => void;
    const rpc = vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      if (path === "/slow") return new Promise((res) => { resolveFirst = res; });
      return Promise.resolve({ ...home, path: path ?? home.path } as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/slow");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await w.get('[data-test="dp-path"]').setValue("/fast");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    resolveFirst({ ...home, path: "/slow" });
    await flushPromises();
    expect((w.get('[data-test="dp-path"]').element as HTMLInputElement).value).toBe("/fast");
  });

  it("shows an inline error and keeps the last list on failure", async () => {
    const rpc = vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = (p as { path?: string }).path;
      if (path === "/nope") return Promise.resolve({ error: { code: "ENOENT", message: "no such directory" } });
      return Promise.resolve(home as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/nope");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.get('[data-test="dp-error"]').text()).toContain("no such directory");
    expect(w.find('[data-test="dp-dir-proj"]').exists()).toBe(true);
  });

  it("shows the truncated notice when the result is truncated", async () => {
    vi.spyOn(api, "rpc").mockResolvedValue({ ...home, truncated: true } as never);
    const w = mountPicker();
    await flushPromises();
    expect(w.find('[data-test="dp-truncated"]').exists()).toBe(true);
  });

  it("initialPath seeds the first navigation", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    mountPicker("/home/me/proj");
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.fs.browse", { path: "/home/me/proj" });
  });

  it("breadcrumb crumb click navigates to the absolute path (POSIX)", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue(home as never);
    const w = mountPicker();
    await flushPromises();
    const crumbs = w.find('nav[aria-label="breadcrumb"]').findAll("button");
    expect(crumbs).toHaveLength(2); // home, me — not relative "home"/"home/me"
    await crumbs[0].trigger("click");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "/home" });
  });

  it("first Windows crumb is the drive root (C:\\)", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({
      ...home, path: "C:\\Users\\me", sep: "\\", parent: "C:\\Users",
    } as never);
    const w = mountPicker();
    await flushPromises();
    const crumbs = w.find('nav[aria-label="breadcrumb"]').findAll("button");
    expect(crumbs).toHaveLength(3);
    await crumbs[0].trigger("click");
    expect(rpc).toHaveBeenLastCalledWith("i1", "control.fs.browse", { path: "C:\\" });
  });

  it("cannot confirm while a navigation is pending (review #293 finding 1)", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = typeof p === "object" && p !== null && "path" in p ? p.path : undefined;
      if (path === "/home/me/proj") return pending.promise;
      return Promise.resolve(home as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-dir-proj"]').trigger("click");
    await flushPromises();
    // Pending navigation: result still holds the OLD listing - confirm must be
    // inert so it can never submit the stale directory.
    expect((w.get('[data-test="dp-confirm"]').element as HTMLButtonElement).disabled).toBe(true);
    pending.resolve({ ...home, path: "/home/me/proj", parent: "/home/me" });
    await flushPromises();
    expect((w.get('[data-test="dp-confirm"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failed navigation realigns the path box to the current directory", async () => {
    vi.spyOn(api, "rpc").mockImplementation((_i, _t, p = {}) => {
      const path = typeof p === "object" && p !== null && "path" in p ? p.path : undefined;
      if (path === "/nope") return Promise.resolve({ error: { code: "ENOENT", message: "no such directory" } });
      return Promise.resolve(home as never);
    });
    const w = mountPicker();
    await flushPromises();
    await w.get('[data-test="dp-path"]').setValue("/nope");
    await w.get('[data-test="dp-path"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    // The failed target must not stay displayed while confirm would submit the
    // old listing's path - the box realigns to what confirm actually submits.
    expect((w.get('[data-test="dp-path"]').element as HTMLInputElement).value).toBe("/home/me");
    await w.get('[data-test="dp-confirm"]').trigger("click");
    expect(w.emitted("confirm")).toEqual([["/home/me"]]);
  });
});
