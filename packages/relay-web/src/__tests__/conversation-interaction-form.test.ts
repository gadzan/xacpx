import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";

import ConversationInteractionForm from "../components/ConversationInteractionForm.vue";
import en from "../i18n/messages/en";
import type { InteractionFieldDto, InteractionRequestDto } from "@ganglion/xacpx-relay-protocol";

const i18n = createI18n({ legacy: false, locale: "en", messages: { en }, missingWarn: false, fallbackWarn: false });

function mountForm(
  fields: InteractionFieldDto[],
  answers: Record<string, unknown> = {},
) {
  const request: InteractionRequestDto = {
    requestId: "req-1",
    kind: "elicitation",
    expiresAt: Date.now() + 60_000,
    // `agent` is REQUIRED on the wire: it is the asking identity, owned by core,
    // and never something the renderer should have to infer.
    elicitation: { mode: "form", message: "Pick.", fields, agent: { name: "codex" } },
  };
  return mount(ConversationInteractionForm, {
    props: {
      request,
      answers: answers as never,
      submitting: false,
      errorCode: null,
      outcome: null,
    },
    global: { plugins: [i18n] },
  });
}

  // The renderer must measure what core measures, and must refuse what it
  // cannot check exactly. Both are terminal-transport rules: the hub resolves the
  // interaction on submit, so an answer the browser allowed and core then rejects
  // is an answer the user can never correct.

  it("string length is counted in CODE POINTS, as core measures it", () => {
    // JS .length counts UTF-16 units, so a single astral character is 2. A
    // minLength: 2 field therefore accepted one emoji here while core counted it
    // as 1 and rejected it — after the form had closed.
    const wrapper = mountForm(
      [{ kind: "text", key: "s", title: "S", required: true, minLength: 2 }],
      { s: "\u{1F600}" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("a format the renderer cannot verify exactly blocks Submit", () => {
    // Core uses ajv-formats; a second implementation here would drift, and the
    // drift would surface only after the interaction had already resolved. So the
    // formats this renderer cannot agree on are refused rather than approximated.
    for (const format of ["uri", "date-time", "some-future-format"]) {
      const wrapper = mountForm(
        [{ kind: "text", key: "f", title: "F", required: true, format }],
        { f: "https://example.com" },
      );
      expect(wrapper.find('[data-test="interaction-invalid"]').exists(), format).toBe(true);
      expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled"), format).toBeDefined();
    }
  });

  it("the required shape is shown as metadata, never executed", () => {
    const wrapper = mountForm([
      { kind: "text", key: "s", title: "S", required: true, pattern: "^[a-z]+$" },
    ]);
    const shown = wrapper.find('[data-test="interaction-pattern"]');
    expect(shown.exists()).toBe(true);
    expect(shown.text()).toContain("^[a-z]+$");
    // A value that does NOT match it is still accepted by the renderer: neither
    // core nor this renderer executes an agent-supplied pattern, so the metadata
    // is advisory and the agent validates its own pattern on the answer it gets.
    const withAnswer = mountForm(
      [{ kind: "text", key: "s", title: "S", required: true, pattern: "^[a-z]+$" }],
      { s: "UPPERCASE" },
    );
    expect(withAnswer.find('[data-test="interaction-invalid"]').exists()).toBe(false);
    expect(withAnswer.find('[data-test="interaction-submit"]').attributes("disabled")).toBe(undefined);
  });

  it("the agent identity is rendered when the frame carries one", async () => {
    const wrapper = mountForm([
      { kind: "text", key: "s", title: "S", required: false },
    ]);
    // The frame the hub now carries: an agent name is REQUIRED on the wire.
    wrapper.setProps({
      request: {
        ...wrapper.props("request") as object,
        elicitation: {
          mode: "form",
          message: "Pick.",
          fields: [{ kind: "text", key: "s", title: "S", required: false }],
          agent: { name: "codex" },
        },
      },
    } as never);
    await wrapper.vm.$nextTick();
    const shown = wrapper.find('[data-test="interaction-agent"]');
    expect(shown.exists()).toBe(true);
    expect(shown.text()).toContain("codex");
  });

describe("ConversationInteractionForm field kinds", () => {
  it("a number field emits a NUMBER, not the input's string", () => {
    // The bug this pins: the generic text input emitted a string, so a number
    // field answered "3" reached core as "3" and was rejected — after the
    // interaction had already resolved, so the user could not correct it.
    const wrapper = mountForm([
      { kind: "number", key: "count", title: "Count", required: true },
    ]);
    const input = wrapper.find('[data-test="interaction-input-count"]');
    (input.element as HTMLInputElement).value = "3";
    input.trigger("input");
    expect(wrapper.emitted("answer")![0]).toEqual(["count", 3]);
    expect(typeof (wrapper.emitted("answer")![0]![1])).toBe("number");
  });

  it("a fractional answer to an integer field is refused", () => {
    const wrapper = mountForm([
      { kind: "number", key: "n", title: "N", required: true, integer: true },
    ]);
    const input = wrapper.find('[data-test="interaction-input-n"]');
    (input.element as HTMLInputElement).value = "1.5";
    input.trigger("input");
    expect(wrapper.emitted("answer")).toBeUndefined();
    // And Submit is blocked with a reason, not sent.
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("number minimum/maximum block submit with a visible problem", () => {
    const wrapper = mountForm(
      [{ kind: "number", key: "port", title: "Port", required: true, minimum: 1, maximum: 65535 }],
      { port: 99999 },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("a multi-select field emits a string[]", () => {
    const wrapper = mountForm([
      {
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
    ]);
    wrapper.find('[data-test="interaction-multi-a"]').trigger("click");
    expect(wrapper.emitted("answer")![0]).toEqual(["tags", ["a"]]);
    // The next toggle is computed from the props the PARENT is asked to apply, so
    // the test re-mounts with the accumulated set rather than expecting the child
    // to hold it: answers live in the store, and a child that kept its own copy
    // could diverge from the store's truth.
    const withA = mountForm(
      [{
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }],
      { tags: ["a"] },
    );
    withA.find('[data-test="interaction-multi-b"]').trigger("click");
    expect(withA.emitted("answer")![0]).toEqual(["tags", ["a", "b"]]);
    // Toggling off removes exactly one value rather than clearing the set.
    const withAB = mountForm(
      [{
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }],
      { tags: ["a", "b"] },
    );
    withAB.find('[data-test="interaction-multi-a"]').trigger("click");
    expect(withAB.emitted("answer")![0]).toEqual(["tags", ["b"]]);
  });

  it("multi-select minItems and maxItems are enforced locally", () => {
    const fields: InteractionFieldDto[] = [
      {
        kind: "multi-select",
        key: "tags",
        title: "Tags",
        required: true,
        minItems: 2,
        maxItems: 3,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
          { value: "d", label: "D" },
        ],
      },
    ];
    expect(mountForm(fields, { tags: ["a"] }).find('[data-test="interaction-submit"]').attributes("disabled"))
      .toBeDefined();
    expect(mountForm(fields, { tags: ["a", "b"] }).find('[data-test="interaction-submit"]').attributes("disabled"))
      .toBeUndefined();
    expect(mountForm(fields, { tags: ["a", "b", "c", "d"] }).find('[data-test="interaction-submit"]').attributes("disabled"))
      .toBeDefined();
  });

  it("text minLength / maxLength / known format are enforced locally", () => {
    const wrapper = mountForm(
      [
        { kind: "text", key: "short", title: "Short", required: true, minLength: 2, maxLength: 4 },
        { kind: "text", key: "when", title: "When", required: false, format: "date" },
      ],
      { short: "x", when: "not-a-date" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("an unparseable date is not emitted as the answer", () => {
    const wrapper = mountForm([
      { kind: "text", key: "when", title: "When", required: true, format: "date" },
    ]);
    const input = wrapper.find('[data-test="interaction-input-when"]');
    (input.element as HTMLInputElement).value = "garbage";
    input.trigger("input");
    expect(wrapper.emitted("answer")).toBeUndefined();
  });

  it("a default is SHOWN but not submitted without a user action", () => {
    // The component claimed "default is shown as the current value" while the
    // store opened with `answers: {}` and the value read `answers[key]` only — so
    // defaults were invisible. Shown now; still never an answer on its own.
    const wrapper = mountForm([
      { kind: "text", key: "region", title: "Region", required: false, defaultValue: "us-east" },
    ]);
    expect(
      (wrapper.find('[data-test="interaction-input-region"]').element as HTMLInputElement).value,
    ).toBe("us-east");
    // Nothing has been emitted: the default is display, not an answer.
    expect(wrapper.emitted("answer")).toBeUndefined();
    // Typing makes it an answer, and Submit is then reachable.
    const input = wrapper.find('[data-test="interaction-input-region"]');
    (input.element as HTMLInputElement).value = "eu-west";
    input.trigger("input");
    expect(wrapper.emitted("answer")![0]).toEqual(["region", "eu-west"]);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBe(undefined);
  });

  it("a numeric default renders in the number control", () => {
    const wrapper = mountForm([
      { kind: "number", key: "replicas", title: "Replicas", required: false, defaultValue: 3 },
    ]);
    expect(
      (wrapper.find('[data-test="interaction-input-replicas"]').element as HTMLInputElement).value,
    ).toBe("3");
  });

  it("a boolean field stays two explicit options and emits a boolean", () => {
    const wrapper = mountForm([{ kind: "boolean", key: "ok", title: "OK?", required: true }]);
    const buttons = wrapper.findAll("button");
    const yes = buttons.find((b) => b.text().includes("Yes"))!;
    yes.trigger("click");
    expect(wrapper.emitted("answer")![0]).toEqual(["ok", true]);
  });

  it("single-select emits the option VALUE, not the label", () => {
    const wrapper = mountForm([
      {
        kind: "single-select",
        key: "env",
        title: "Env",
        required: true,
        options: [{ value: "prod", label: "Production!" }],
      },
    ]);
    const select = wrapper.find('[data-test="interaction-select-env"]');
    (select.element as HTMLSelectElement).value = "prod";
    select.trigger("change");
    expect(wrapper.emitted("answer")![0]).toEqual(["env", "prod"]);
  });
});
