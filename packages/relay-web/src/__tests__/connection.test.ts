import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import {
  useConnectionStore,
  connectionStatus,
  RECONNECTING_MS,
  OFFLINE_WARN_MS,
} from "../stores/connection";
import ConnectionBadge from "../components/ConnectionBadge.vue";
import { i18n } from "../i18n";

describe("connectionStatus", () => {
  it("is neutral before the first socket opens", () => {
    expect(connectionStatus({ online: false, everOpened: false, offlineMs: null })).toBe("connecting");
    // Still connecting after a failed first attempt: nothing was ever up.
    expect(connectionStatus({ online: false, everOpened: false, offlineMs: 60_000 })).toBe("connecting");
  });

  it("reports online once the socket is open", () => {
    expect(connectionStatus({ online: true, everOpened: true, offlineMs: null })).toBe("online");
    expect(connectionStatus({ online: true, everOpened: false, offlineMs: 5_000 })).toBe("online");
  });

  it("escalates a drop by age", () => {
    const dropped = { online: false, everOpened: true } as const;
    expect(connectionStatus({ ...dropped, offlineMs: null })).toBe("reconnecting");
    expect(connectionStatus({ ...dropped, offlineMs: 0 })).toBe("reconnecting");
    expect(connectionStatus({ ...dropped, offlineMs: RECONNECTING_MS - 1 })).toBe("reconnecting");
    expect(connectionStatus({ ...dropped, offlineMs: RECONNECTING_MS })).toBe("degraded");
    expect(connectionStatus({ ...dropped, offlineMs: OFFLINE_WARN_MS - 1 })).toBe("degraded");
    expect(connectionStatus({ ...dropped, offlineMs: OFFLINE_WARN_MS })).toBe("lost");
    expect(connectionStatus({ ...dropped, offlineMs: 10 * OFFLINE_WARN_MS })).toBe("lost");
  });
});

describe("connection store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.useRealTimers());

  it("defaults to disconnected then reflects status", () => {
    const s = useConnectionStore();
    expect(s.online).toBe(false);
    expect(s.everOpened).toBe(false);
    expect(s.offlineSince).toBeNull();
    s.setStatus({ online: true, everOpened: true });
    expect(s.online).toBe(true);
    expect(s.everOpened).toBe(true);
    expect(s.offlineSince).toBeNull();
    s.setStatus({ online: false, everOpened: true });
    expect(s.online).toBe(false);
    expect(s.everOpened).toBe(true);
  });

  it("stamps the drop once and never restarts the clock on a repeat report", () => {
    vi.useFakeTimers();
    const s = useConnectionStore();
    s.setStatus({ online: false, everOpened: true });
    const first = s.offlineSince;
    expect(first).not.toBeNull();
    vi.advanceTimersByTime(5_000);
    s.setStatus({ online: false, everOpened: true });
    expect(s.offlineSince).toBe(first);
    s.setStatus({ online: true, everOpened: true });
    expect(s.offlineSince).toBeNull();
  });

  it("ages a stored drop into degraded and lost", () => {
    vi.useFakeTimers();
    const s = useConnectionStore();
    s.setStatus({ online: false, everOpened: true });
    const since = s.offlineSince!;
    const status = () =>
      connectionStatus({ online: s.online, everOpened: s.everOpened, offlineMs: Date.now() - since });
    expect(status()).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECTING_MS);
    expect(status()).toBe("degraded");
    vi.advanceTimersByTime(OFFLINE_WARN_MS);
    expect(status()).toBe("lost");
  });
});

describe("ConnectionBadge", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    vi.useRealTimers();
    i18n.global.locale.value = "en";
  });

  it("shows the neutral connecting state on a cold start", () => {
    const w = mount(ConnectionBadge);
    expect(w.get('[data-test="conn-badge"]').text()).toContain("Connecting");
    expect(w.find("span.rounded-full").classes()).toContain("bg-fg-muted");
  });

  it("shows the run-bright online state", () => {
    const conn = useConnectionStore();
    conn.setStatus({ online: true, everOpened: true });
    const w = mount(ConnectionBadge);
    expect(w.get('[data-test="conn-badge"]').text()).toContain("Connected");
    expect(w.find("span.rounded-full").classes()).toContain("bg-run-bright");
  });

  it("escalates the badge as a drop ages", async () => {
    vi.useFakeTimers();
    const conn = useConnectionStore();
    conn.setStatus({ online: true, everOpened: true });
    const w = mount(ConnectionBadge);
    conn.setStatus({ online: false, everOpened: true });
    await nextTick();
    const dot = () => w.find("span.rounded-full").classes();
    const text = () => w.get('[data-test="conn-badge"]').text();
    expect(dot()).toContain("bg-fg-muted");
    expect(text()).toContain("Reconnecting");
    vi.advanceTimersByTime(RECONNECTING_MS + 10);
    await nextTick();
    expect(dot()).toContain("bg-warn");
    vi.advanceTimersByTime(OFFLINE_WARN_MS);
    await nextTick();
    expect(dot()).toContain("bg-danger");
  });
});
