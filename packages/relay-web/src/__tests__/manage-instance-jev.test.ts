// packages/relay-web/src/__tests__/manage-instance-jev.test.ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ManageInstanceDialog from "../components/ManageInstanceDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";
import { i18n } from "../i18n";

const STORED = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  keyConfigured: true,
  keyMasked: "sk-…abcd",
};

/** Answer the Jev RPCs and record every call. `get`/`update`/`test` may be
 *  functions (per-call) or plain values. */
function stubJev(answers: {
  get?: unknown;
  update?: unknown;
  test?: unknown;
  getError?: Error;
} = {}) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (type === "control.jev.get") {
      if (answers.getError) throw answers.getError;
      return (answers.get ?? STORED) as never;
    }
    if (type === "control.jev.update") return (answers.update ?? STORED) as never;
    return (answers.test ?? { ok: true, latencyMs: 812 }) as never;
  });
  return calls;
}

function mountDialog() {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null, sessions: [], sessionsLoaded: true,
    agents: [], workspaces: [], agentCatalog: [],
  }];
  vi.spyOn(store, "loadFormOptions").mockResolvedValue(undefined as never);
  return mount(ManageInstanceDialog, {
    props: { instanceId: "i1", instanceName: "pc" },
    global: { stubs: { WorkspacesManager: true, AgentsManager: true, Teleport: true } },
  });
}

const writes = (calls: Array<{ type: string; payload: unknown }>) =>
  calls.filter((call) => call.type === "control.jev.update");

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  i18n.global.locale.value = "en";
});

test("the Jev form shows the masked key and the pinned model, never the key itself", async () => {
  stubJev();
  const w = mountDialog();
  await flushPromises();
  const key = w.find('[data-test="jev-api-key"]');
  expect(w.find('[data-test="jev-settings"]').exists()).toBe(true);
  expect(key.attributes("placeholder")).toBe("sk-…abcd");
  expect((key.element as HTMLInputElement).value).toBe("");
  expect(w.find('[data-test="jev-api-key-masked"]').text()).toContain("sk-…abcd");
  expect(w.find('[data-test="jev-model"]').text()).toBe("jev-1.13.0");
  expect(w.find('[data-test="jev-proxy"]').text()).toBe("");
  expect(w.find('[data-test="jev-settings"]').text()).toContain(
    i18n.global.t("instance.jevProxyHint"),
  );
});

test("typing a key and saving patches only the key", async () => {
  const calls = stubJev({ update: { ...STORED, keyMasked: "sk-…1234" } });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-api-key"]').setValue("sk-12345678901234");
  await w.find('[data-test="jev-save"]').trigger("click");
  await flushPromises();
  expect(writes(calls)).toEqual([{ type: "control.jev.update", payload: { apiKey: "sk-12345678901234" } }]);
  expect(w.find('[data-test="jev-api-key-masked"]').text()).toContain("sk-…1234");
  // The draft is consumed: the next save does not resend the same key.
  await w.find('[data-test="jev-save"]').trigger("click");
  await flushPromises();
  expect(writes(calls)[1]?.payload).toEqual({});
});

test("the clear button removes the stored key with an explicit null", async () => {
  const calls = stubJev({ update: { ...STORED, keyConfigured: false, keyMasked: null } });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-api-key-clear"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-test="jev-api-key-masked"]').exists()).toBe(false);
  await w.find('[data-test="jev-save"]').trigger("click");
  await flushPromises();
  expect(writes(calls)).toEqual([{ type: "control.jev.update", payload: { apiKey: null } }]);
});

test("a proxy override is sent as typed; an untouched field stays out of the patch", async () => {
  const calls = stubJev();
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-proxy"]').setValue("http://127.0.0.1:8080");
  await w.find('[data-test="jev-save"]').trigger("click");
  await flushPromises();
  expect(writes(calls)).toEqual([{ type: "control.jev.update", payload: { proxyUrl: "http://127.0.0.1:8080" } }]);
});

test("a daemon rejection surfaces as the form's error line", async () => {
  const calls = stubJev();
  calls.length = 0;
  vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string, payload: unknown = {}) => {
    calls.push({ type, payload });
    if (type === "control.jev.get") return STORED as never;
    throw new Error("proxyUrl must use the http or https scheme");
  });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-proxy"]').setValue("socks5://127.0.0.1:1080");
  await w.find('[data-test="jev-save"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-test="jev-error"]').text()).toBe("proxyUrl must use the http or https scheme");
  // A failed save leaves the draft in place so it can be corrected.
  expect((w.find('[data-test="jev-proxy"]').element as HTMLInputElement).value).toBe(
    "socks5://127.0.0.1:1080",
  );
});

test("the test connection button reports latency for a good key", async () => {
  const calls = stubJev({ test: { ok: true, latencyMs: 812 } });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-test"]').trigger("click");
  await flushPromises();
  expect(calls.some((call) => call.type === "control.jev.test")).toBe(true);
  const result = w.find('[data-test="jev-test-result"]');
  expect(result.text()).toBe(i18n.global.t("instance.jevTest.ok", { ms: 812 }));
  expect(result.classes()).toContain("text-success");
});

test("the test connection button maps 451 and 401/403 to actionable copy", async () => {
  stubJev({ test: { ok: false, code: "region-blocked", message: "TypeSafe is not available in this region." } });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-test"]').trigger("click");
  await flushPromises();
  expect(w.find('[data-test="jev-test-result"]').text()).toBe(i18n.global.t("instance.jevTest.region-blocked"));
  expect(w.find('[data-test="jev-test-result"]').classes()).toContain("text-error");
});

test("the test connection button tests the unsaved draft key without saving it", async () => {
  const calls = stubJev({ test: { ok: true, latencyMs: 40 } });
  const w = mountDialog();
  await flushPromises();
  await w.find('[data-test="jev-api-key"]').setValue("sk-unsaved");
  await w.find('[data-test="jev-test"]').trigger("click");
  await flushPromises();
  expect(calls.find((call) => call.type === "control.jev.test")?.payload).toEqual({ apiKey: "sk-unsaved" });
  expect(writes(calls)).toEqual([]);
});

test("an older daemon without the Jev RPCs shows the upgrade notice instead of the form", async () => {
  stubJev({
    getError: new Error(
      "This feature needs a newer connector — rebuild and reconnect the relay channel on that instance.",
    ),
  });
  const w = mountDialog();
  await flushPromises();
  expect(w.find('[data-test="jev-settings"]').exists()).toBe(false);
  expect(w.find('[data-test="jev-upgrade-notice"]').text()).toBe(
    i18n.global.t("instance.jevUpgradeNotice"),
  );
});
