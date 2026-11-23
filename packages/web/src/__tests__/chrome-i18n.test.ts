import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { i18n } from "../i18n";
import ConnectionBadge from "../components/ConnectionBadge.vue";
import { useConnectionStore } from "../stores/connection";

describe("ConnectionBadge i18n", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => { i18n.global.locale.value = "en"; });

  it("renders Chinese when locale is zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    const w = mount(ConnectionBadge);
    // Cold start: the neutral connecting label, not a reconnect error.
    expect(w.get('[data-test="conn-badge"]').text()).toContain("连接中");
    useConnectionStore().setStatus({ online: true, everOpened: true });
    await nextTick();
    expect(w.text()).toContain("已连接");
  });

  it("renders English by default", async () => {
    const w = mount(ConnectionBadge);
    expect(w.get('[data-test="conn-badge"]').text()).toContain("Connecting");
    useConnectionStore().setStatus({ online: true, everOpened: true });
    await nextTick();
    expect(w.text()).toContain("Connected");
  });
});
