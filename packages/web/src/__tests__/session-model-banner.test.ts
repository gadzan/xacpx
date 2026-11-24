import { mount } from "@vue/test-utils";
import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import SessionModelBanner from "../components/SessionModelBanner.vue";
import { i18n } from "../i18n";
import { useChatStore } from "../stores/chat";
import { useInstancesStore, type InstanceView } from "../stores/instances";
import { useSessionControlsStore } from "../stores/session-controls";

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});

function banner(): Element | null {
  return document.body.querySelector('[data-test="model-banner"]');
}

it("shows an automatic load failure in the global banner", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = 'bridge request "getSessionModel" timed out after 45000ms';
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const el = banner();
  expect(el).not.toBeNull();
  // Long bridge diagnostics wrap and scroll instead of being clipped by the composer.
  expect(el?.textContent).toContain('bridge request "getSessionModel" timed out after 45000ms');
  expect(el?.textContent).toContain("Model state unavailable");
});

it("keeps explicit switch failures on the toast and out of the banner", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = "requested model-b; authoritative model is model-a";
  controls.modelErrorSource = "set";

  mount(SessionModelBanner);
  await nextTick();

  expect(banner()).toBeNull();
});

it("dismisses the banner and clears the diagnostic", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = "timed out";
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const dismiss = document.body.querySelector<HTMLButtonElement>('[data-test="model-banner-dismiss"]');
  expect(dismiss).not.toBeNull();
  dismiss?.click();
  await nextTick();

  expect(banner()).toBeNull();
  expect(controls.modelError).toBe("");
  expect(controls.modelErrorSource).toBe("");
});

it("leads an adapter auth failure with the login hint and keeps the diagnostic", async () => {
  const chat = useChatStore();
  const instances = useInstancesStore();
  const previous = i18n.global.locale.value;
  i18n.global.locale.value = "zh-CN";
  try {
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [{ alias: "backend", agent: "omp", workspace: "/w", transportSession: "t", running: false, archived: false }],
      agents: [], workspaces: [], agentCatalog: [],
    } satisfies InstanceView];
    chat.instanceId = "i1";
    chat.sessionAlias = "backend";
    await nextTick();
    const controls = useSessionControlsStore();
    const detail = 'model catalog refresh failed for agent "omp" session "relay:xacpx-omp": unauthenticated: the adapter requires authentication before it can list models';
    controls.modelError = detail;
    controls.modelErrorSource = "load";

    mount(SessionModelBanner);
    await nextTick();

    const text = banner()?.textContent ?? "";
    expect(text).toContain("omp 尚未在主机上完成认证");
    expect(text).toContain(detail);
    expect(text.indexOf("尚未在主机上完成认证")).toBeLessThan(text.indexOf(detail));
  } finally {
    i18n.global.locale.value = previous;
  }
});

it("leaves a non-auth refresh diagnostic on the existing banner copy", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = "model catalog refresh failed for agent \"omp\" session \"relay:x\": timeout: the capability probe timed out";
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("Model state unavailable");
  expect(text).not.toContain("log it in there");
});

it("does not read an auth-shaped session alias as an auth failure", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = 'model catalog refresh failed for agent "omp" session "relay:authoring": timeout: the capability probe timed out';
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("Model state unavailable");
  expect(text).not.toContain("isn't authenticated on the host");
});

it("ignores the alias prefix on a thrown probe diagnostic with no failure token", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = 'model catalog refresh failed for agent "omp" session "relay:authoring": adapter offline';
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("Model state unavailable");
  expect(text).not.toContain("isn't authenticated on the host");
});

it("keeps the hint when the probe text itself reports an expired login", async () => {
  const controls = useSessionControlsStore();
  const detail = 'model catalog refresh failed for agent "omp" session "relay:authoring": transport: adapter auth expired';
  controls.modelError = detail;
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("isn't authenticated on the host");
  expect(text.indexOf("isn't authenticated on the host")).toBeLessThan(text.indexOf(detail));
});

it("still leads unauthenticated when the session alias looks like auth", async () => {
  const instances = useInstancesStore();
  instances.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
    sessions: [{ alias: "relay:authoring", agent: "omp", workspace: "/w", transportSession: "t", running: false, archived: false }],
    agents: [], workspaces: [], agentCatalog: [],
  } satisfies InstanceView];
  const chat = useChatStore();
  chat.instanceId = "i1";
  chat.sessionAlias = "relay:authoring";
  const controls = useSessionControlsStore();
  const detail = 'model catalog refresh failed for agent "omp" session "relay:authoring": unauthenticated: the adapter requires authentication before it can list models';
  controls.modelError = detail;
  controls.modelErrorSource = "load";
  await nextTick();

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("omp isn't authenticated on the host");
  expect(text.indexOf("isn't authenticated on the host")).toBeLessThan(text.indexOf(detail));
});

it("names the agent generically when the session row is not loaded yet", async () => {
  const controls = useSessionControlsStore();
  controls.modelError = 'model catalog refresh failed for agent "omp" session "relay:x": unauthenticated: the adapter requires authentication before it can list models';
  controls.modelErrorSource = "load";

  mount(SessionModelBanner);
  await nextTick();

  const text = banner()?.textContent ?? "";
  expect(text).toContain("This agent isn't authenticated on the host");
  expect(text).toContain("unauthenticated: the adapter requires authentication");
});
