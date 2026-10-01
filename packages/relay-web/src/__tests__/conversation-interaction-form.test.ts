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

  it("code-point length governs a CHOSEN option too", () => {
    // The astral case, on the option path: one emoji is ONE character per
    // JSON Schema, and `.length` calls it 2. Core measures the chosen option in
    // code points, so `minLength: 2` over a single-emoji option is an answer core
    // rejects — and the only value the field can produce is that emoji.
    const wrapper = mountForm(
      [{
        kind: "single-select",
        key: "mood",
        title: "Mood",
        required: true,
        minLength: 2,
        options: [{ value: "\u{1F600}", label: "Singular emoji" }],
      }],
      { mood: "\u{1F600}" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("every format CORE VALIDATES blocks Submit", () => {
    // Core uses ajv-formats; a second implementation here would drift, and the
    // drift would surface only after the interaction had already resolved. So
    // the formats this renderer cannot agree on are refused rather than
    // approximated.
    //
    // `date` and `email` are listed on purpose: they were once hand-rolled here
    // and both diverged — `Date.parse` normalizes 2026-02-30 into March, and the
    // email regex accepted `a..b@example.com` that core rejects. Only a value
    // this renderer can verify exactly may be allowed through, and the set of
    // those is empty.
    for (const format of ["uri", "date-time", "date", "email"]) {
      const wrapper = mountForm(
        [{ kind: "text", key: "f", title: "F", required: true, format }],
        { f: "2026-02-30" },
      );
      expect(wrapper.find('[data-test="interaction-invalid"]').exists(), format).toBe(true);
      expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled"), format).toBeDefined();
    }
  });

  it("an UNKNOWN format is preserved and DOES NOT block Submit", () => {
    // The mirror image of the test above, and a bug it used to pin the wrong way.
    //
    // Core's format dispatch ends in `default: return true` — an unknown name is
    // an annotation the client must preserve for the renderer to interpret, not a
    // constraint anything enforces. Blocking Submit on it would invent a rule
    // core does not have, and the field would be permanently unanswerable while
    // the agent sees a legal form.
    for (const format of ["some-future-format", "idn-email", "custom-vendor-thing"]) {
      const wrapper = mountForm(
        [{ kind: "text", key: "f", title: "F", required: true, format }],
        { f: "2026-02-30" },
      );
      expect(wrapper.find('[data-test="interaction-invalid"]').exists(), format).toBe(false);
      expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled"), format).toBe(undefined);
    }
  });

  it("a selected OPTION the renderer cannot verify blocks Submit too", () => {
    // The same round-5 gap the `text` test above cannot see: core applies the
    // agent's string constraints to a `single-select`'s CHOSEN OPTION, and its
    // validator says so ("The agent's own string constraints apply to the chosen
    // option too"). `enum: ["2026-02-30"]` with `format: "date"` is a legal
    // schema whose only offered value core's strict `isDate` rejects.
    //
    // The control looks perfectly reasonable in the browser — the agent itself
    // offered that option — so the check cannot be "did the user type something
    // odd", it has to be the same field constraint applied to the selected value.
    const wrapper = mountForm(
      [{
        kind: "single-select",
        key: "day",
        title: "Day",
        required: true,
        format: "date",
        options: [{ value: "2026-02-30", label: "Feb 30" }],
      }],
      { day: "2026-02-30" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("minLength and maxLength apply to the CHOSEN option, not just typed text", () => {
    // `enum: ["x"]` with `minLength: 2`: the user can only pick `x`, and core
    // rejects `x` on the same code-point measurement it uses for text. Blocking
    // on the NOTE is impossible here — a browser that only length-checks `text`
    // lets this through and core rejects after the interaction resolved.
    const wrapper = mountForm(
      [{
        kind: "single-select",
        key: "pick",
        title: "Pick",
        required: true,
        minLength: 2,
        options: [{ value: "x", label: "Only" }],
      }],
      { pick: "x" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
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
  it("an OPTIONAL field cleared to \"\" is still validated against its constraints", async () => {
    // Presence and emptiness are two different facts, and conflating them was the
    // bug. The store holds answers as own properties, so a user who types "a" and
    // then deletes it leaves a real `""` — and `collectInteractionAnswers()`
    // sends that `""` verbatim as the answer.
    //
    // Treating `""` as absent let an OPTIONAL field skip every constraint:
    // `minLength: 1` was submittable, the hub resolved Accepted, and core — which
    // receives the genuine `""` — rejected it after the form was gone.
    const wrapper = mountForm([
      { kind: "text", key: "note", title: "Note", required: false, minLength: 1 },
    ]);
    // The answer the user leaves behind after typing and clearing.
    wrapper.setProps({ answers: { note: "" } as never });
    await wrapper.vm.$nextTick();
    const cleared = wrapper.find('[data-test="interaction-input-note"]');
    (cleared.element as HTMLInputElement).value = "";
    cleared.trigger("input");
    expect(wrapper.emitted("answer")).toEqual([["note", ""]]);
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("an OPTIONAL field left UNTOUCHED is not validated", () => {
    // The control for the test above: `undefined` is absence, and absence is what
    // `required` governs. Nothing was answered, so there is nothing to check —
    // and an optional field with no answer is submittable (ACP's "accept with no
    // answers"), which is legitimate and must not be blocked.
    const wrapper = mountForm([
      { kind: "text", key: "note", title: "Note", required: false, minLength: 1 },
    ]);
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBe(undefined);
  });

  it("an OPTIONAL format field cleared to \"\" is not silently accepted", async () => {
    // The same hole on the format path: `""` reaches core as the answer, and a
    // core-validated format has nothing the browser can check exactly about it.
    const wrapper = mountForm([
      { kind: "text", key: "mail", title: "Mail", required: false, format: "email" },
    ]);
    wrapper.setProps({ answers: { mail: "" } as never });
    await wrapper.vm.$nextTick();
    const input = wrapper.find('[data-test="interaction-input-mail"]');
    (input.element as HTMLInputElement).value = "";
    input.trigger("input");
    expect(wrapper.emitted("answer")).toEqual([["mail", ""]]);
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

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

  it("text minLength / maxLength are enforced locally", () => {
    const wrapper = mountForm(
      [
        { kind: "text", key: "short", title: "Short", required: true, minLength: 2, maxLength: 4 },
      ],
      { short: "x" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
  });

  it("an impossible CALENDAR date is refused, not normalized away", () => {
    // The decisive counterexample to the old approximation. `Date.parse` accepts
    // "2026-02-30" by rolling it over to March 2nd, so the old check let Submit
    // through, the hub resolved the interaction, and core's `isDate` — which
    // range-checks the day against `daysInMonth` — then rejected the answer. The
    // user could no longer correct it.
    //
    // A value that is not a real calendar date must therefore be refused here or
    // nowhere. Note the browser's own parser does NOT agree, which is the point.
    expect(Number.isNaN(Date.parse("2026-02-30"))).toBe(false);
    const wrapper = mountForm(
      [{ kind: "text", key: "when", title: "When", required: true, format: "date" }],
      { when: "2026-02-30" },
    );
    expect(wrapper.find('[data-test="interaction-invalid"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
    // And the user is told the control cannot be checked, NOT that their value is
    // wrong: this is the renderer's limit, not a judgment about the answer.
    const message = wrapper.find('[data-test="interaction-invalid"]').text();
    expect(message).toContain("When:");
    expect(message).toContain("cannot be checked yet");
  });

  it("a string the renderer cannot verify is still emitted as the answer", () => {
    // Fail closed at Submit, never at input. A `date`/`email`/`uri` value is
    // carried through unchanged: blocking the keystroke would silently discard
    // the user's text, and the only safe place to draw the line is Submit, where
    // the user is told why.
    const wrapper = mountForm([
      { kind: "text", key: "when", title: "When", required: true, format: "date" },
    ]);
    const input = wrapper.find('[data-test="interaction-input-when"]');
    (input.element as HTMLInputElement).value = "garbage";
    input.trigger("input");
    expect(wrapper.emitted("answer")).toEqual([["when", "garbage"]]);
    // Submit is offered nowhere near it.
    expect(wrapper.find('[data-test="interaction-submit"]').attributes("disabled")).toBeDefined();
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

// An `id` is what `label[for]` binds to, so a duplicate id mislabels a control:
// the binding resolves to whichever element the browser saw first, and clicking
// the title focuses a different field's input.

describe("ConversationInteractionForm control ids", () => {
  it("fields whose keys sanitize to the SAME string get DIFFERENT ids", () => {
    // The two keys differ only by the hyphen, which the sanitizer strips, so any
    // id derived from the key alone hands both controls the same `id` and one
    // field's label is bound to the other field's input. The answer is
    // unaffected (the handler closes over `field.key`), so nothing else catches it.
    const wrapper = mountForm([
      { kind: "text", key: "a-b", title: "A hyphen", required: true },
      { kind: "text", key: "ab", title: "Ab", required: true },
    ]);
    const ids = [
      wrapper.find('[data-test="interaction-input-a-b"]').attributes("id"),
      wrapper.find('[data-test="interaction-input-ab"]').attributes("id"),
    ];
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
    // Each label names its own control, not whichever one the document saw first.
    const labels = wrapper.findAll("label");
    expect(labels.map((l) => l.attributes("for"))).toEqual(ids);
  });

  it("the id a field gets is STABLE across re-renders", () => {
    // A random or time-based component would break `label[for]` on the next
    // repaint, so the uniqueness must come from something the renderer already
    // holds still — here, the index of a field list derived from an immutable
    // request.
    const wrapper = mountForm([
      { kind: "text", key: "a", title: "A", required: true },
      { kind: "text", key: "b", title: "B", required: true },
    ]);
    const before = wrapper.find('[data-test="interaction-input-a"]').attributes("id");
    wrapper.setProps({ submitting: true });
    expect(wrapper.find('[data-test="interaction-input-a"]').attributes("id")).toBe(before);
  });
});
