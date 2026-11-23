// Smooth-first preference in the desktop store: default off, persisted, pushed
// to a live connection. Presentation-only; never session or ticket state.
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useDesktopStore } from "../stores/desktop";

describe("desktop store smooth-first preference", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("defaults to off", () => {
    expect(useDesktopStore().viewFor("i1").smooth).toBe(false);
  });

  it("persists across store instances via localStorage", () => {
    useDesktopStore().setSmooth("i1", true);
    expect(localStorage.getItem("xacpx.desktop.smooth")).toBe("1");
    setActivePinia(createPinia());
    expect(useDesktopStore().viewFor("i2").smooth).toBe(true);
    useDesktopStore().setSmooth("i2", false);
    expect(localStorage.getItem("xacpx.desktop.smooth")).toBe("0");
  });
});
