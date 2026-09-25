import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

import DesktopTab from "../components/DesktopTab.vue";
import { useDesktopStore } from "../stores/desktop";
vi.mock("../lib/desktop-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/desktop-client")>();
  return {
    ...actual,
    connectDesktopRfb: vi.fn((input: unknown) => actual.connectDesktopRfb(input as never)),
  };
});
vi.mock("../api/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/events")>();
  return {
    ...actual,
    requestDesktop: vi.fn(async () => ({
      requestId: "r1",
      instanceId: "i1",
      streamId: "s1",
      wsPath: "/desktop/observe?ticket=t",
      expiresAt: 1,
      security: "vnc-auth",
    })),
    sendWebClientMessage: vi.fn(),
  };
});

describe("DesktopTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("hands the mounted desktop-host element to the RFB client as its target", async () => {
    const wrapper = mount(DesktopTab, { props: { instanceId: "i1" } });
    await flushPromises();
    const store = useDesktopStore();
    expect(store.viewFor("i1").streamId).toBe("s1");
    const host = wrapper.find('[data-test="desktop-host"]');
    expect(host.exists()).toBe(true);
    const { connectDesktopRfb } = await import("../lib/desktop-client");
    const calls = (connectDesktopRfb as unknown as { mock: { calls: Array<[{ target?: HTMLElement }]> } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // The RFB constructor must receive the element that is actually in the DOM —
    // a detached fallback div would connect fine yet render a black tab.
    expect(calls[calls.length - 1]?.[0]?.target).toBe(host.element);
    wrapper.unmount();
  });

  it("narrows the tunneled session to outer VncAuth so Tight sub-auth cannot select no-auth", async () => {
    const instances: Array<{ check: (type: number) => boolean }> = [];
    function FakeRfb(this: unknown) {
      const self = this as { _isSupportedSecurityType: (type: number) => boolean };
      self._isSupportedSecurityType = () => true;
      instances.push({ check: (type: number) => self._isSupportedSecurityType(type) });
    }
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as { getMockImplementation?: () => ((input: never) => unknown) }).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      loadNoVnc: async () => ({ default: FakeRfb as never }),
    }) as { dispose: () => void };
    await vi.waitFor(() => expect(instances.length).toBe(1));
    // must accept 2 and reject Tight (16), or the verdict cannot constrain
    // the real connection (sub-auth can select STDVNOAUTH__).
    expect(instances[0]?.check(2)).toBe(true);
    expect(instances[0]?.check(16)).toBe(false);
    expect(instances[0]?.check(1)).toBe(false);
    conn.dispose();
  });
});
