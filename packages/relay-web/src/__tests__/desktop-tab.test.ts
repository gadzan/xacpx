import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";

import DesktopTab from "../components/DesktopTab.vue";
import { useDesktopStore } from "../stores/desktop";
import type { DesktopRfbConnectInput, DesktopRfbConnection, NoVncRfb } from "../lib/desktop-client";
import type { MockedFunction } from "vitest";
import { DESKTOP_ERROR_CODES } from "@ganglion/xacpx-relay-protocol";
import { desktopErrorKey } from "../lib/desktop-error-i18n";
vi.mock("../lib/desktop-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/desktop-client")>();
  return {
    ...actual,
    connectDesktopRfb: vi.fn((input: DesktopRfbConnectInput) => actual.connectDesktopRfb(input)),
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
    // Typed as the constructor DesktopRfbConnectInput.loadNoVnc's module expects,
    // so the object literal below satisfies the input without `as never`, which
    // would forfeit type-checking at exactly the place it matters (the RFB ctor).
    const FakeRfb = function FakeRfb(this: unknown) {
      const self = this as unknown as {
        _isSupportedSecurityType: (type: number) => boolean;
        _negotiateAuthentication: () => boolean;
        _fail: (details: string) => boolean;
      };
      self._isSupportedSecurityType = () => true;
      self._negotiateAuthentication = () => true;
      self._fail = () => false;
      instances.push({ check: (type: number) => self._isSupportedSecurityType(type) });
    } as unknown as new (
      target: HTMLElement,
      url: string,
      options: Record<string, unknown>,
    ) => NoVncRfb;
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    // The mock is a passthrough (`input => actual.connectDesktopRfb(input)`), so
    // read its implementation back to drive the real connect path with a fake
    // noVNC module. Cast the mock itself, never the call argument.
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      loadNoVnc: async () => ({ default: FakeRfb }),
    });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    // must accept 2 and reject Tight (16), or the verdict cannot constrain
    // the real connection (sub-auth can select STDVNOAUTH__).
    expect(instances[0]?.check(2)).toBe(true);
    expect(instances[0]?.check(16)).toBe(false);
    expect(instances[0]?.check(1)).toBe(false);
    conn.dispose();
  });

  it("fails closed when the real tunnel presents a non-VncAuth scheme at Authentication entry (RFB 3.3 TOCTOU)", async () => {
    interface FakeInstance {
      _rfbAuthScheme: number;
      _failReason?: string;
      _negotiateAuthentication: () => boolean;
    }
    const instances: FakeInstance[] = [];
    const FakeRfb = function FakeRfb(this: unknown) {
      const self = this as unknown as FakeInstance & {
        _isSupportedSecurityType: (type: number) => boolean;
        _fail: (details: string) => boolean;
      };
      self._isSupportedSecurityType = () => true;
      self._rfbAuthScheme = -1;
      self._negotiateAuthentication = () => true;
      self._fail = (details: string) => { self._failReason = details; return false; };
      instances.push(self);
    } as unknown as new (
      target: HTMLElement,
      url: string,
      options: Record<string, unknown>,
    ) => NoVncRfb;
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      loadNoVnc: async () => ({ default: FakeRfb }),
    });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const rfb = instances[0];
    if (!rfb) throw new Error("no tunneled session captured");
    // Scheme 2 (probe verdict) still enters Authentication normally.
    rfb._rfbAuthScheme = 2;
    expect(rfb._negotiateAuthentication()).toBe(true);
    expect(rfb._failReason).toBeUndefined();
    // TOCTOU: second connection swaps type 2 for None after a passing probe.
    // RFB 3.3 never consults _isSupportedSecurityType; the Authentication
    // entry guard must fail closed instead of completing with no password.
    for (const scheme of [1, 16, 0, -1]) {
      rfb._rfbAuthScheme = scheme;
      rfb._failReason = undefined;
      expect(rfb._negotiateAuthentication()).toBe(false);
      expect(rfb._failReason).toMatch(/only outer VncAuth is allowed/);
    }
    conn.dispose();
  });

  it("wires the full credentials lifecycle: required event, password send, and dispose", async () => {
    // Regression: the narrowing patch once dropped `rfb = rfbInstance`, so
    // no listener ever registered, credentialsrequired never reached the
    // store, sendCredentials was a no-op, and dispose never disconnected.
    interface FakeRfbShape {
      listeners: Map<string, Array<(event: Record<string, unknown>) => void>>;
      /** Mirrors upstream: `sendCredentials(creds)` assigns _rfbCredentials. */
      credentials: Array<Record<string, unknown>>;
      disconnected: boolean;
      scaleViewport: boolean;
    }
    const instances: FakeRfbShape[] = [];
    const FakeRfb = function FakeRfb(this: unknown) {
      const self = this as unknown as FakeRfbShape & NoVncRfb & {
        _isSupportedSecurityType: (type: number) => boolean;
        _negotiateAuthentication: () => boolean;
        _fail: (details: string) => boolean;
        _rfbAuthScheme: number;
      };
      const shape: FakeRfbShape = {
        listeners: new Map(),
        credentials: [],
        disconnected: false,
        scaleViewport: false,
      };
      instances.push(shape);
      self._rfbAuthScheme = 2;
      self._isSupportedSecurityType = () => true;
      self._negotiateAuthentication = () => true;
      self._fail = () => false;
      self.addEventListener = (type: string, listener: (event: Record<string, unknown>) => void) => {
        const list = shape.listeners.get(type) ?? [];
        list.push(listener);
        shape.listeners.set(type, list);
      };
      self.removeEventListener = () => {};
      // Upstream contract: sendCredentials stores the OBJECT and VncAuth later
      // reads `_rfbCredentials.password`. A fake that accepts a bare string
      // would prove nothing about the real API.
      self.sendCredentials = (credentials: Record<string, unknown>) => { shape.credentials.push(credentials); };
      self.disconnect = () => { shape.disconnected = true; };
      self.scaleViewport = false;
    } as unknown as new (
      target: HTMLElement,
      url: string,
      options: Record<string, unknown>,
    ) => NoVncRfb;
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    let credentialPrompts = 0;
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      hooks: { onCredentialsRequired: () => { credentialPrompts += 1; } },
      loadNoVnc: async () => ({ default: FakeRfb }),
    });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const shape = instances[0];
    if (!shape) throw new Error("no tunneled session captured");
    // All four lifecycle listeners must reach the live instance.
    for (const type of ["connect", "disconnect", "credentialsrequired", "securityfailure"]) {
      expect(shape.listeners.get(type)?.length ?? 0).toBe(1);
    }
    // credentialsrequired flows to the hook; the password flows back in.
    for (const listener of shape.listeners.get("credentialsrequired") ?? []) listener({});
    expect(credentialPrompts).toBe(1);
    conn.sendCredentials("s3cret");
    // Upstream VncAuth reads `.password` off the credentials OBJECT, so the
    // wrapper must send an object — a bare string leaves `.password` undefined
    // and noVNC re-fires credentialsrequired forever.
    expect(shape.credentials).toEqual([{ password: "s3cret" }]);
    expect((shape.credentials[0] as { password?: string }).password).toBe("s3cret");
    conn.setScaleViewport(false);
    conn.dispose();
    expect(shape.disconnected).toBe(true);
  });

  it("a fit toggle during the async noVNC import is not overwritten by the construction snapshot", async () => {
    // Regression: on resolve the wrapper re-applied `input.fit` (the
    // construction-time snapshot), so toggling Actual while noVNC was still
    // loading got flipped back to Fit once the module arrived.
    interface FakeRfbShape {
      listeners: Map<string, Array<(event: Record<string, unknown>) => void>>;
      credentials: Array<Record<string, unknown>>;
      disconnected: boolean;
      scaleViewport: boolean;
    }
    const instances: FakeRfbShape[] = [];
    const FakeRfb = function FakeRfb(this: unknown) {
      const self = this as unknown as FakeRfbShape & NoVncRfb & {
        _isSupportedSecurityType: (type: number) => boolean;
        _negotiateAuthentication: () => boolean;
        _fail: (details: string) => boolean;
        _rfbAuthScheme: number;
      };
      const shape: FakeRfbShape = {
        listeners: new Map(),
        credentials: [],
        disconnected: false,
        scaleViewport: false,
      };
      instances.push(shape);
      self._rfbAuthScheme = 2;
      self._isSupportedSecurityType = () => true;
      self._negotiateAuthentication = () => true;
      self._fail = () => false;
      self.addEventListener = () => {};
      self.removeEventListener = () => {};
      self.sendCredentials = (credentials: Record<string, unknown>) => { shape.credentials.push(credentials); };
      self.disconnect = () => { shape.disconnected = true; };
      // A real writable property: the wrapper's assignment must land here.
      Object.defineProperty(self, "scaleViewport", {
        enumerable: true,
        get: () => shape.scaleViewport,
        set: (v: boolean) => { shape.scaleViewport = v; },
      });
    } as unknown as new (
      target: HTMLElement,
      url: string,
      options: Record<string, unknown>,
    ) => NoVncRfb;

    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");

    // Deferred module: nothing is constructed until we release it.
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => { release = resolve; });
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      fit: true,
      loadNoVnc: async () => { await loaded; return { default: FakeRfb }; },
    });

    // No instance yet — and the switch to Actual must stick across the import.
    expect(instances.length).toBe(0);
    conn.setScaleViewport(false);
    release();
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const shape = instances[0];
    if (!shape) throw new Error("no tunneled session captured");
    expect(shape.scaleViewport).toBe(false);

    // And the reverse: a toggle ON during the import applies too.
    conn.setScaleViewport(true);
    expect(shape.scaleViewport).toBe(true);
    conn.dispose();
  });

  it("applies the initial fit flag once noVNC resolves", async () => {
    const instances: Array<{ scaleViewport: boolean }> = [];
    const FakeRfb = function FakeRfb(this: unknown) {
      const shape = { scaleViewport: false };
      instances.push(shape);
      const self = this as unknown as {
        addEventListener: () => void;
        removeEventListener: () => void;
        sendCredentials: () => void;
        disconnect: () => void;
        _isSupportedSecurityType: () => boolean;
        _negotiateAuthentication: () => boolean;
        _fail: () => boolean;
        _rfbAuthScheme: number;
        scaleViewport: boolean;
      };
      self._rfbAuthScheme = 2;
      self._isSupportedSecurityType = () => true;
      self._negotiateAuthentication = () => true;
      self._fail = () => false;
      self.addEventListener = () => {};
      self.removeEventListener = () => {};
      self.sendCredentials = () => {};
      self.disconnect = () => {};
      Object.defineProperty(self, "scaleViewport", {
        enumerable: true,
        get: () => shape.scaleViewport,
        set: (v: boolean) => { shape.scaleViewport = v; },
      });
    } as unknown as new (
      target: HTMLElement,
      url: string,
      options: Record<string, unknown>,
    ) => NoVncRfb;
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      fit: true,
      loadNoVnc: async () => ({ default: FakeRfb }),
    });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    expect(instances[0]?.scaleViewport).toBe(true);
    conn.dispose();
  });

  it("fails closed when noVNC internals drift instead of connecting unconstrained", async () => {
    // P2 hardening: the auth narrowing depends on noVNC 1.7.0 private hooks
    // (_isSupportedSecurityType/_negotiateAuthentication/_fail). If a future
    // upgrade removes them, the session must surface securityfailure, never
    // connect with an unconstrained handshake.
    function FakeRfb(this: unknown) {
      // No private hooks at all: simulates a noVNC version that renamed them.
    }
    const { connectDesktopRfb: mocked } = await import("../lib/desktop-client");
    const real = (mocked as unknown as MockedFunction<(input: DesktopRfbConnectInput) => DesktopRfbConnection>).getMockImplementation?.();
    if (!real) throw new Error("connectDesktopRfb mock missing passthrough");
    let failure: string | undefined;
    const conn = real({
      url: "wss://hub/desktop/observe?ticket=t",
      security: "vnc-auth",
      hooks: { onSecurityFailure: (reason: string) => { failure = reason; } },
      loadNoVnc: async () => ({ default: FakeRfb as unknown as new (
        target: HTMLElement,
        url: string,
        options: Record<string, unknown>,
      ) => NoVncRfb }),
    });
    await vi.waitFor(() => expect(failure).toBeDefined());
    expect(failure).toMatch(/auth guard unavailable/);
    conn.dispose();
  });
});

describe("DesktopTab error i18n", () => {
  // Every stable desktop error code must render a TRANSLATED string in the
  // banner. A code that falls through shows the raw protocol string (e.g.
  // "desktop-instance-offline") in an otherwise localized UI — the exact class
  // of bug that survived several review rounds because only two codes were
  // exercised by hand.
  for (const code of DESKTOP_ERROR_CODES) {
    it(`translates ${code} instead of showing the raw code`, async () => {
      const { i18n } = await import("../i18n");
      const wrapper = mount(DesktopTab, {
        props: { instanceId: "i1" },
        global: { plugins: [i18n] },
      });
      const store = useDesktopStore();
      // Seed the error row AFTER mount: the component's open() overwrites an
      // earlier status, and the banner only renders from a set row.
      await flushPromises();
      store.sessions.set("i1", {
        instanceId: "i1",
        status: "error",
        needsPassword: false,
        fit: true,
        lastErrorCode: code,
        lastErrorMessage: "hub detail",
      });
      await flushPromises();
      const banner = wrapper.find('[data-test="desktop-error"]');
      expect(banner.exists()).toBe(true);
      expect(banner.text()).not.toContain(code);
      // The hub's own detail still rides along: useful diagnostics survive.
      expect(banner.text()).toContain("hub detail");
      wrapper.unmount();
    });
  }

  it("keeps both locales free of raw codes for every desktop error code", async () => {
    const { i18n } = await import("../i18n");
    const locales = ["en", "zh-CN"] as const;
    for (const locale of locales) {
      i18n.global.locale.value = locale;
      for (const code of DESKTOP_ERROR_CODES) {
        const key = desktopErrorKey(code);
        expect(key, `${code} has no i18n key`).toBeTruthy();
        const translated = i18n.global.t(key!);
        // vue-i18n returns the key itself when a message is missing.
        expect(translated, `${code}/${locale} missing translation`).not.toBe(key);
      }
    }
  });
});
