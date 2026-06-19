import { afterEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { i18n } from "../i18n";
import ConnectionBadge from "../components/ConnectionBadge.vue";

describe("ConnectionBadge i18n", () => {
  afterEach(() => { i18n.global.locale.value = "en"; });

  it("renders Chinese when locale is zh-CN", () => {
    setActivePinia(createPinia());
    i18n.global.locale.value = "zh-CN";
    const w = mount(ConnectionBadge);
    expect(w.get('[data-test="conn-badge"]').text()).toContain("重新连接中");
  });

  it("renders English by default", () => {
    setActivePinia(createPinia());
    const w = mount(ConnectionBadge);
    expect(w.get('[data-test="conn-badge"]').text()).toContain("Reconnecting");
  });
});
