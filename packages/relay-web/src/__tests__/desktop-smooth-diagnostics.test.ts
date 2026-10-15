// Smooth-first encoding preferences and the opt-in encoding diagnostic.
// Smooth-first only REQUESTS lower quality / higher compression through
// noVNC's public properties; these tests prove what is SENT, not what a
// server does with it (未实测 on a real Mac).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { connectDesktopRfb, type NoVncRfb } from "../lib/desktop-client";
import { DesktopEncodingProbe } from "../lib/desktop-encoding-diagnostics";

interface Shape {
  writes: Array<[string, number]>;
  qualityLevel: number;
  compressionLevel: number;
  listeners: Map<string, Array<(e: Record<string, unknown>) => void>>;
  handleDataRect?: () => boolean;
  fbu: { encoding: number | null };
}

function makeFakeRfb(opts: { internals?: boolean } = {}) {
  const instances: Array<Shape & { self: Record<string, unknown> }> = [];
  const FakeRfb = function FakeRfb(this: unknown) {
    const self = this as Record<string, unknown>;
    const shape: Shape & { self: Record<string, unknown> } = {
      writes: [],
      qualityLevel: 6,
      compressionLevel: 2,
      listeners: new Map(),
      fbu: { encoding: null },
      self,
    };
    instances.push(shape);
    self._rfbAuthScheme = 2;
    self._isSupportedSecurityType = () => true;
    self._negotiateAuthentication = () => true;
    self._fail = () => false;
    self.addEventListener = (type: string, l: (e: Record<string, unknown>) => void) => {
      const list = shape.listeners.get(type) ?? [];
      list.push(l);
      shape.listeners.set(type, list);
    };
    self.removeEventListener = () => {};
    self.sendCredentials = () => {};
    self.disconnect = () => {};
    self.scaleViewport = false;
    for (const key of ["qualityLevel", "compressionLevel"] as const) {
      Object.defineProperty(self, key, {
        enumerable: true,
        get: () => shape[key],
        set: (v: number) => { shape.writes.push([key, v]); shape[key] = v; },
      });
    }
    if (opts.internals !== false) {
      self._FBU = shape.fbu;
      self._qualityLevel = 6;
      self._compressionLevel = 2;
      self._handleDataRect = () => shape.handleDataRect?.() ?? true;
    }
  } as unknown as new (t: HTMLElement, u: string, o: Record<string, unknown>) => NoVncRfb;
  return { FakeRfb, instances };
}

const URL_WITH_TICKET = "wss://hub/desktop/observe?ticket=TICKET-SECRET-77ab";

describe("smooth-first (流畅优先)", () => {
  beforeEach(() => localStorage.clear());

  it("default OFF leaves noVNC qualityLevel/compressionLevel untouched", async () => {
    const { FakeRfb, instances } = makeFakeRfb();
    const conn = connectDesktopRfb({ url: URL_WITH_TICKET, security: "ard", loadNoVnc: async () => ({ default: FakeRfb }) });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    expect(instances[0]!.writes).toEqual([]);
    expect(instances[0]!.qualityLevel).toBe(6);
    expect(instances[0]!.compressionLevel).toBe(2);
    conn.dispose();
  });

  it("ON requests lower quality and higher compression via the public properties", async () => {
    const { FakeRfb, instances } = makeFakeRfb();
    const conn = connectDesktopRfb({ url: URL_WITH_TICKET, security: "vnc-auth", smooth: true, loadNoVnc: async () => ({ default: FakeRfb }) });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const shape = instances[0]!;
    expect(shape.qualityLevel).toBeLessThan(6);
    expect(shape.compressionLevel).toBeGreaterThan(2);
    // Live toggle OFF restores noVNC's own defaults; ON again re-requests.
    conn.setSmoothFirst(false);
    expect(shape.qualityLevel).toBe(6);
    expect(shape.compressionLevel).toBe(2);
    conn.setSmoothFirst(true);
    expect(shape.qualityLevel).toBeLessThan(6);
    conn.dispose();
  });

  it("a toggle during the async noVNC import is applied once the module resolves", async () => {
    const { FakeRfb, instances } = makeFakeRfb();
    let release!: () => void;
    const loaded = new Promise<void>((r) => { release = r; });
    const conn = connectDesktopRfb({
      url: URL_WITH_TICKET,
      security: "ard",
      loadNoVnc: async () => { await loaded; return { default: FakeRfb }; },
    });
    conn.setSmoothFirst(true);
    release();
    await vi.waitFor(() => expect(instances.length).toBe(1));
    expect(instances[0]!.qualityLevel).toBeLessThan(6);
    expect(instances[0]!.compressionLevel).toBeGreaterThan(2);
    conn.dispose();
  });

  it("the auth guard is still installed with smooth-first ON", async () => {
    const { FakeRfb, instances } = makeFakeRfb();
    const conn = connectDesktopRfb({ url: URL_WITH_TICKET, security: "ard", smooth: true, loadNoVnc: async () => ({ default: FakeRfb }) });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const self = instances[0]!.self as { _isSupportedSecurityType: (t: number) => boolean };
    // ARD stream: only inner scheme 1 (None after connector pre-auth) passes.
    expect(self._isSupportedSecurityType(1)).toBe(true);
    expect(self._isSupportedSecurityType(2)).toBe(false);
    expect(self._isSupportedSecurityType(30)).toBe(false);
    conn.dispose();
  });
});

describe("encoding diagnostics (opt-in)", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    delete (window as { __xacpxDesktopDiag?: unknown }).__xacpxDesktopDiag;
  });

  it("is off by default: the rect handler is not wrapped and nothing is logged", async () => {
    const { FakeRfb, instances } = makeFakeRfb();
    const conn = connectDesktopRfb({ url: URL_WITH_TICKET, security: "ard", loadNoVnc: async () => ({ default: FakeRfb }) });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const shape = instances[0]!;
    const original = shape.self._handleDataRect;
    expect(window.__xacpxDesktopDiag).toBeUndefined();
    for (const l of shape.listeners.get("disconnect") ?? []) l({ detail: { clean: true } });
    expect(info).not.toHaveBeenCalled();
    expect(shape.self._handleDataRect).toBe(original);
    conn.dispose();
  });

  it("when enabled, counts completed rects per encoding and logs counts only", async () => {
    localStorage.setItem("xacpx.desktop.diagnostics", "1");
    const { FakeRfb, instances } = makeFakeRfb();
    const conn = connectDesktopRfb({ url: URL_WITH_TICKET, security: "ard", smooth: true, loadNoVnc: async () => ({ default: FakeRfb }) });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    const shape = instances[0]!;
    const handle = shape.self._handleDataRect as () => boolean;
    // A rect that needs more bytes (false) must not be counted until it completes.
    shape.fbu.encoding = 16; shape.handleDataRect = () => false; handle();
    shape.handleDataRect = () => true; handle();
    shape.fbu.encoding = 1; handle();
    shape.fbu.encoding = 16; handle();
    const summary = window.__xacpxDesktopDiag?.();
    expect(summary?.available).toBe(true);
    expect(summary?.rects).toBe(3);
    expect(summary?.smoothFirst).toBe(true);
    expect(summary?.encodings).toEqual([
      { encoding: 1, name: "CopyRect", count: 1 },
      { encoding: 16, name: "ZRLE", count: 2 },
    ]);
    for (const l of shape.listeners.get("disconnect") ?? []) l({ detail: { clean: true } });
    expect(info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("TICKET-SECRET-77ab");
    expect(logged).not.toContain("ticket");
    conn.dispose();
    expect(window.__xacpxDesktopDiag).toBeUndefined();
  });

  it("fails soft when noVNC internals are missing", async () => {
    const probe = new DesktopEncodingProbe({});
    expect(probe.available).toBe(false);
    expect(probe.summary(false)).toMatchObject({ available: false, rects: 0, encodings: [] });
    localStorage.setItem("xacpx.desktop.diagnostics", "1");
    const { FakeRfb, instances } = makeFakeRfb({ internals: false });
    let connected = 0;
    const conn = connectDesktopRfb({
      url: URL_WITH_TICKET,
      security: "vnc-auth",
      hooks: { onConnect: () => { connected += 1; } },
      loadNoVnc: async () => ({ default: FakeRfb }),
    });
    await vi.waitFor(() => expect(instances.length).toBe(1));
    for (const l of instances[0]!.listeners.get("connect") ?? []) l({});
    expect(connected).toBe(1);
    expect(window.__xacpxDesktopDiag?.().available).toBe(false);
    conn.dispose();
  });
});

describe("noVNC 1.7.0 contract for smooth-first and the encoding probe", () => {
  const require = createRequire(import.meta.url);
  const root = require.resolve("@novnc/novnc").replace(/[\\/]core[\\/][^\\/]+$/, "");
  const rfb = readFileSync(resolve(root, "core/rfb.js"), "utf8");

  it("public quality/compression setters re-send SetEncodings while connected", () => {
    expect(rfb).toMatch(/this\._qualityLevel = 6;/);
    expect(rfb).toMatch(/this\._compressionLevel = 2;/);
    expect(rfb).toMatch(/set qualityLevel\(qualityLevel\) \{[\s\S]*?this\._sendEncodings\(\);/);
    expect(rfb).toMatch(/set compressionLevel\(compressionLevel\) \{[\s\S]*?this\._sendEncodings\(\);/);
    // The levels travel only as pseudo-encodings in the client's SetEncodings.
    expect(rfb).toMatch(/encs\.push\(encodings\.pseudoEncodingQualityLevel0 \+ this\._qualityLevel\);/);
    expect(rfb).toMatch(/encs\.push\(encodings\.pseudoEncodingCompressLevel0 \+ this\._compressionLevel\);/);
  });

  it("data rects dispatch through _handleDataRect with the parsed _FBU.encoding", () => {
    expect(rfb).toMatch(/default:\s*return this\._handleDataRect\(\);/);
    expect(rfb).toMatch(/_handleDataRect\(\) \{\s*let decoder = this\._decoders\[this\._FBU\.encoding\];/);
  });
});
