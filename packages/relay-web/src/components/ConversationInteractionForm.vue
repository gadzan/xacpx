<script setup lang="ts">
/**
 * Feishu-independent renderer for an open relay interaction.
 *
 * Renders whatever the hub-validated `InteractionRequestDto` asks, and reports
 * the user's decision back to the store. This is the last link of the chain
 * agent -> ACP -> core -> relay -> browser -> decision -> same turn.
 *
 * Design constraints the component enforces (or the store does, on its behalf):
 *
 *   - Answers are held until Submit, never sent per keystroke. A half-finished
 *     form is nobody else's business.
 *   - The default is shown as the CURRENT VALUE, editable, so a default can
 *     never be submitted unlooked-at.
 *   - Decline and Cancel are separate controls with separate outcomes.
 *   - All agent-supplied text renders as data: no `v-html` anywhere.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, Loader2, X } from "lucide-vue-next";
import type {
  InteractionFieldDto,
  InteractionRequestDto,
  InteractionValueDto,
} from "@ganglion/xacpx-relay-protocol";

const props = defineProps<{
  request: InteractionRequestDto;
  /**
   * What the user has entered so far.
   *
   * Passed in rather than read off `request` on purpose: the request is the
   * hub-validated payload and must stay immutable, while answers are local
   * state that changes on every keystroke. Reading them off the request would
   * mean either mutating a protocol object or looking at a field that is not
   * there.
   */
  answers: Record<string, InteractionValueDto>;
  submitting: boolean;
  errorCode: string | null;
  outcome: "accepted" | "declined" | "cancelled" | "withdrawn" | "gone" | null;
}>();

const emit = defineEmits<{
  (e: 'answer', key: string, value: InteractionValueDto): void;
  (e: 'submit'): void;
  (e: 'decline'): void;
  (e: 'cancel'): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();

const fields = computed<readonly InteractionFieldDto[]>(() => props.request.elicitation?.fields ?? []);

/**
 * The asking Agent's identity, or empty when the frame carried none.
 *
 * Rendered as data in its own element, never merged into the message text: the
 * identity is trusted core state, while `message`/`schemaTitle` are
 * agent-controlled and must not be able to impersonate it.
 */
const agentName = computed<string>(() => props.request.elicitation?.agent?.name ?? "");

/**
 * Schema-level presentation text: the form's own title and description.
 *
 * Agent-controlled, like `message`, and shown beside it. Shown WITHOUT them a
 * form whose `message` is empty — which the wire validator permits precisely
 * because "a schema with a good title needs no prose" — presents nothing above
 * its fields and asks nothing at all.
 */
const schemaTitle = computed<string>(() => props.request.elicitation?.schemaTitle ?? "");

const schemaDescription = computed<string>(() => props.request.elicitation?.schemaDescription ?? "");

/**
 * Own-property presence for an answer.
 *
 * `!== undefined` is not enough: a field keyed `constructor` or `toString` reads
 * a value `Object.prototype` always provides, so an unanswered required field
 * looks answered. Answers arrive as a null-prototype map from the store, and this
 * is the matching check.
 */
function hasAnswer(answers: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(answers, key) && answers[key] !== undefined;
}

const requiredMissing = computed<readonly InteractionFieldDto[]>(() =>
  fields.value.filter((field) => field.required && !hasAnswer(props.answers, field.key)),
);

const messageLines = computed<readonly string[]>(() => {
  const message = props.request.elicitation?.message ?? '';
  return message.length === 0 ? [] : message.split('\n');
});

/**
 * The DOM `id` a field's control uses, for `<label :for>` to bind to it.
 *
 * The sanitized key alone is NOT unique: `a-b` and `ab` both sanitize to `ab`,
 * and two keys sharing their first 16 sanitized characters collide outright. A
 * duplicate `id` leaves `label[for]` bound to whichever element the browser saw
 * first, so one field's title names a different field's input and clicking it
 * focuses the wrong control. The answer itself is unaffected — the `@input`
 * handlers close over `field.key` — but the form is then mislabeled.
 *
 * The v-for index therefore leads the id. It is unique per rendered field, so no
 * key shape can collide, and it is stable across re-renders because the field
 * list is derived from the immutable request: no random or time-based component,
 * which would break `label[for]` on every repaint.
 */
function controlName(index: number, field: InteractionFieldDto): string {
  return `f${index}-${field.key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)}`;
}

/**
 * Does this field render ONE control that carries `controlName(index, field)` as
 * its `id`?
 *
 * Only those may use `<label for>`: a `for` that resolves to no control is worse
 * than no label, because it actively misleads assistive tech and anything that
 * walks `for` -> element. `boolean` and `multi-select` render a SET of controls
 * and carry no single id, so they get a labelled group instead. `number`, `text`,
 * and `single-select` each render exactly one, with the id set on it.
 */
function labelableControl(field: InteractionFieldDto): boolean {
  return field.kind === "text" || field.kind === "number" || field.kind === "single-select";
}

/**
 * Typed coercion for the field the user is editing.
 *
 * Each field kind has a wire type core will validate against, so the renderer
 * MUST emit that type: a number field answered as a string reaches core as a
 * string and is rejected, and the transport is terminal — the hub has already
 * resolved the interaction by then, so the user cannot correct it. Coercing here
 * is what makes an invalid edit visible while the form is still open.
 */
function coerce(
  field: InteractionFieldDto,
  raw: string,
): { ok: true; value: InteractionValueDto } | { ok: false } {
  const trimmed = raw.trim();
  if (field.kind === "number") {
    if (trimmed === "") return { ok: true, value: undefined as never };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { ok: false };
    // integer constraint is the field's own, and it is enforced here rather than
    // deferred: a fractional answer to an integer field is rejected later, after
    // the form has already closed.
    if (field.integer === true && !Number.isInteger(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  }
  if (field.kind === "text") {
    // No `format` narrowing here on purpose. An earlier revision narrowed
    // `date` with `Date.parse` and `email` with a regex; `Date.parse` normalizes
    // `2026-02-30` to March 2nd instead of rejecting it, so the browser accepted a
    // calendar date core's `isDate` refuses, and the disagreement only surfaced
    // after the hub had already resolved the interaction. See `formatProblem`.
    return { ok: true, value: raw };
  }
  return { ok: true, value: raw };
}

/**
 * Per-field problems the renderer can detect BEFORE Submit.
 *
 * Terminal transport is why this exists locally. A hub that validated shape only
 * resolved the interaction; core then rejected the answer set, and the form was
 * already gone — an ordinary typo became an unrecoverable failure. Checking the
 * field's own bounds turns it into a message the user can act on.
 *
 * The rules below deliberately mirror core's rather than inventing their own,
 * and where core uses a library the renderer cannot share, the renderer flags the
 * value unverifiable instead of approximating it.
 */

/**
 * JSON Schema string length is in Unicode CODE POINTS, not JS UTF-16 units.
 *
 * `.length` disagrees for every astral character — `"😀".length === 2` but is
 * ONE character per the spec — so a `minLength: 2` field accepted a single
 * emoji, the browser allowed Submit, the hub resolved, and core then rejected
 * the answer. That ordering is irreversible.
 *
 * Same measurement core uses (`codePointLength`), for the same reason.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/**
 * Formats the renderer checks itself: NONE.
 *
 * This is deliberate and it is a correction. An earlier revision claimed
 * `date` and `email` were "simple enough to agree exactly" and hand-rolled
 * them; they are not, and both were wrong:
 *
 *   - `date` used `Date.parse`, which NORMALIZES an impossible calendar date
 *     instead of rejecting it. `Date.parse("2026-02-30")` is
 *     `2026-03-02T00:00:00Z`, so the browser allowed Submit, the hub resolved
 *     the interaction, and core's `isDate()` — which range-checks the day
 *     against `daysInMonth(year, month)` — then rejected the answer. The user
 *     could no longer correct it.
 *   - `email` used a simplified regex that disagrees with `ajv-formats`,
 *     which is what core actually calls.
 *
 * Core itself documents why: three hand-rolled attempts each fixed one
 * direction while breaking another. And this module cannot simply import
 * core's answer, because `elicitation-schema.ts` pulls in `ajv` at module
 * scope, so the browser would have to ship the JSON Schema engine to read one
 * string.
 *
 * So the four names core actually validates are all `unverifiable`, and
 * `unverifiable` blocks Submit. That is the fail-closed direction: the user is
 * told the control cannot be validated yet instead of being allowed to
 * construct an answer core will refuse.
 *
 * An UNKNOWN format is the opposite case and must NOT be blocked. Core's
 * dispatch has a `default` that returns `true` — it accepts anything — and its
 * comment says why: an unknown format is not this package's to reject, because
 * the ACP RFD requires clients to preserve unknown formats for the renderer to
 * interpret. An unknown name is therefore an ANNOTATION the renderer is free to
 * display, not a constraint it should enforce, and refusing it would invent a
 * rule core does not have.
 */
const CORE_VALIDATED_FORMATS: ReadonlySet<string> = new Set(["email", "uri", "date", "date-time"]);

function formatProblem(field: InteractionFieldDto, _value: string): string | null {
  if (field.format === undefined || field.format === "text") return null;
  // Only the names core validates can be mismatched. Anything else is preserved
  // and accepted, so the renderer has nothing to be wrong about.
  return CORE_VALIDATED_FORMATS.has(field.format) ? "unverifiable" : null;
}

/**
 * The agent's own string constraints on a value this field already carries.
 *
 * Applies to `text` AND `single-select`. Core's comment in
 * `validateElicitationAnswer` is explicit: "The agent's own string constraints
 * apply to the chosen option too." A `single-select` is not a free-text control,
 * but its value is still an agent-supplied string, so `minLength`, `maxLength`,
 * and `format` are evaluated against it exactly as for typed text.
 *
 * That is not theoretical. `enum: ["2026-02-30"]` with `format: date` is a legal
 * schema: the browser shows a list the agent itself offered, the user picks the
 * only entry, Submit is enabled, the hub resolves Accepted — and core then
 * rejects it, because core runs the strict calendar check the browser cannot
 * run. The user cannot correct it, because the form is gone. `enum: ["x"]` with
 * `minLength: 2` is the same shape.
 *
 * `pattern` remains the one exception, for both kinds: never executed, only
 * displayed. See the note in the `text` path.
 */
function stringConstraintProblems(field: InteractionFieldDto, value: string): string[] {
  const problems: string[] = [];
  const length = codePointLength(value);
  if (field.minLength !== undefined && length < field.minLength) problems.push("minLength");
  if (field.maxLength !== undefined && length > field.maxLength) problems.push("maxLength");
  const format = formatProblem(field, value);
  if (format !== null) problems.push(format);
  return problems;
}

function fieldProblems(field: InteractionFieldDto, answer: InteractionValueDto | undefined): string[] {
  const problems: string[] = [];
  // PRESENCE and EMPTINESS are two different facts, and conflating them is the
  // bug this replaces.
  //
  // `answer === undefined` means the field was never answered — that is what
  // `required` governs. A string answer of `""` is NOT absent: the store holds
  // answers as own properties (`Object.hasOwn(answers, key) && answers[key] !==
  // undefined`), so a user who typed `"a"` and then deleted it leaves a real
  // `""` behind, and `collectInteractionAnswers()` sends it verbatim as the
  // answer to that field.
  //
  // Treating `""` as absent here meant an OPTIONAL field skipped every
  // constraint: `minLength: 1` with the user's `""` was submittable, the hub
  // resolved Accepted, and core — which receives the genuine `""` and runs
  // `codePointLength(value) < minLength` — rejected it after the form was gone.
  // The same hole for `format: email`/`date`.
  if (answer === undefined) {
    if (field.required) problems.push("required");
    return problems;
  }
  // From here the field HAS an answer, so its constraints apply to whatever that
  // answer is — including the empty string the user left behind.
  if (field.kind === "text" || field.kind === "single-select") {
    problems.push(...stringConstraintProblems(field, String(answer)));
    // NOTE: `field.pattern` is deliberately NOT evaluated here.
    //
    // Core states the rule and the reason: an agent-provided regex is never
    // executed, because uncontrolled regex evaluation is a resource-exhaustion
    // vector. A catastrophically-backtracking pattern would run on every
    // keystroke and every re-render of this component, freezing the dashboard —
    // and the pattern is attacker-supplied text the hub validates for length
    // only, precisely so it does not have to be compiled.
    //
    // Nor does core execute it: the pattern is metadata for a renderer to DISPLAY
    // and for the agent to validate its own answer against. The renderer shows
    // it below and leaves the check to the agent.
  }
  if (field.kind === "number") {
    const value = Number(answer);
    if (field.minimum !== undefined && value < field.minimum) problems.push("minimum");
    if (field.maximum !== undefined && value > field.maximum) problems.push("maximum");
    if (field.integer === true && !Number.isInteger(value)) problems.push("integer");
  }
  if (field.kind === "multi-select") {
    const values = Array.isArray(answer) ? answer : [];
    if (field.minItems !== undefined && values.length < field.minItems) problems.push("minItems");
    if (field.maxItems !== undefined && values.length > field.maxItems) problems.push("maxItems");
  }
  if (field.kind === "single-select") {
    // A selection outside the offered options is not an answer core can accept,
    // and the client is the only party that knows the option set.
    if (field.options !== undefined && !field.options.some((option) => option.value === answer)) {
      problems.push("option");
    }
  }
  return problems;
}

/** Every field that would be rejected, so Submit can be blocked with a reason. */
const invalidFields = computed<readonly { field: InteractionFieldDto; problems: string[] }[]>(() =>
  fields.value
    .map((field) => ({ field, problems: fieldProblems(field, hasAnswer(props.answers, field.key) ? props.answers[field.key] as InteractionValueDto : undefined) }))
    .filter((entry) => entry.problems.length > 0),
);

const canSubmit = computed<boolean>(() => invalidFields.value.length === 0);

/**
 * Human-readable text for one problem token.
 *
 * The tokens are internal (`minLength`, `unverifiable`), and showing them raw
 * would put a compiler-facing word in front of a user. `unverifiable` in
 * particular is a statement about the RENDERER, not about the user's answer, so
 * it gets wording that says the control cannot be checked yet rather than
 * implying the value is wrong.
 */
function problemLabel(problem: string): string {
  if (problem === "unverifiable") return t("bot.interaction.formatUnverifiable");
  if (problem === "required") return t("bot.interaction.problemRequired");
  if (problem === "integer") return t("bot.interaction.problemInteger");
  return problem;
}

/** Multi-select selections are a set, so toggling an option adds or removes it. */
function onMultiToggle(field: InteractionFieldDto, optionValue: string): void {
  const current = hasAnswer(props.answers, field.key) ? props.answers[field.key] : undefined;
  const selected = Array.isArray(current) ? current : [];
  emit('answer', field.key, selected.includes(optionValue)
    ? selected.filter((v) => v !== optionValue)
    : [...selected, optionValue]);
}

function onNumberInput(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  if (!target) return;
  const result = coerce(field, target.value);
  if (result.ok) emit('answer', field.key, result.value);
}

function onTextInput(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  if (!target) return;
  const result = coerce(field, target.value);
  if (result.ok) emit('answer', field.key, result.value);
}

function onSelect(field: InteractionFieldDto, event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  if (!target) return;
  emit('answer', field.key, target.value);
}
</script>

<template>
  <div
    data-test="interaction-form"
    class="w-full rounded-lg border border-warning/40 bg-warning/5 p-3 space-y-3"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
          <AlertTriangle :size="12" />
          <span>{{ t('bot.interaction.title') }}</span>
        </div>
        <!-- The asking Agent's identity, as its own element.
          ACP requires the client to identify who is asking, and the contract is
          explicit that `message`/`schemaTitle` text must NOT stand in for it —
          that text is agent-controlled, so mounting an identity out of it would let
          any agent claim any name. -->
        <div
          v-if="agentName"
          data-test="interaction-agent"
          class="flex items-center gap-1.5 text-[11px] text-fg-muted"
        >
          <span class="uppercase tracking-wide">{{ t('bot.interaction.requestedBy') }}</span>
          <span class="font-medium text-fg">{{ agentName }}</span>
        </div>
        <!-- Schema-level presentation: title and description.
          Both are agent-controlled text, rendered as data with the same no-v-html
          rule as the message.

          This is not decoration. The wire validator allows `message: ""` on
          purpose, "a schema with a good title needs no prose" — so an agent may
          put its ENTIRE question in the schema. When neither title nor description
          is shown, such a form opens with nothing above the fields and asks
          nothing. Shown here so the form always has a question. -->
        <div
          v-if="schemaTitle"
          data-test="interaction-schema-title"
          class="text-xs font-semibold text-fg"
        >{{ schemaTitle }}</div>
        <div
          v-if="schemaDescription"
          data-test="interaction-schema-description"
          class="whitespace-pre-wrap text-xs text-fg"
        >{{ schemaDescription }}</div>
        <!-- Agent-controlled text, rendered as data. No v-html: the point is that
          nothing the agent wrote can become markup here. -->
        <div
          v-for="(line, index) in messageLines"
          :key="index"
          class="whitespace-pre-wrap text-xs text-fg"
        >{{ line }}</div>
      </div>
      <button
        v-if="outcome"
        type="button"
        data-test="interaction-dismiss"
        class="shrink-0 rounded p-1 text-fg-muted hover:bg-surface hover:text-fg transition-colors"
        :aria-label="t('bot.interaction.dismiss')"
        @click="emit('dismiss')"
      >
        <X :size="13" />
      </button>
    </div>

    <!-- Terminal notice. A hub-side close is `withdrawn`, never `cancelled`: the
      user did not choose it and the UI must not claim they did. `gone` is the
      neutral case — the open-set snapshot proved the window closed but says
      nothing about who or why — so it must not fall through to a named outcome. -->
    <div
      v-if="outcome"
      data-test="interaction-outcome"
      class="text-xs font-medium"
      :class="outcome === 'accepted' ? 'text-ok' : outcome === 'declined' ? 'text-warning' : 'text-fg-muted'"
    >
      {{ outcome === 'accepted' ? t('bot.interaction.accepted')
        : outcome === 'declined' ? t('bot.interaction.declined')
        : outcome === 'cancelled' ? t('bot.interaction.cancelled')
        : outcome === 'gone' ? t('bot.interaction.gone')
        : t('bot.interaction.withdrawn') }}
    </div>

    <template v-else>
      <div
        v-for="(field, index) in fields"
        :key="field.key"
        class="space-y-1"
        :data-test="`interaction-field-${field.key}`"
      >
        <!-- Label association.
          `<label for>` is emitted only for the kinds that render a control
          carrying this exact `id`: a `for` that points at nothing is not merely
          useless, it misleads assistive tech and any tooling that resolves
          `for` -> control. `boolean` (a pair of buttons) and `multi-select` (a
          checkbox group) have no single control to name, so their title becomes a
          labelled group: a `role="group"` element named by the legend span. -->
        <label
          v-if="labelableControl(field)"
          class="flex items-baseline gap-1.5 text-xs font-medium text-fg"
          :for="controlName(index, field)"
        >
          <span>{{ field.title }}</span>
          <span v-if="!field.required" class="text-[10.5px] font-normal text-fg-muted">
            ({{ t('bot.interaction.optional') }})
          </span>
        </label>
        <div
          v-else
          :id="controlName(index, field)"
          role="group"
          :aria-labelledby="`${controlName(index, field)}-legend`"
          class="flex items-baseline gap-1.5 text-xs font-medium text-fg"
        >
          <span :id="`${controlName(index, field)}-legend`">{{ field.title }}</span>
          <span v-if="!field.required" class="text-[10.5px] font-normal text-fg-muted">
            ({{ t('bot.interaction.optional') }})
          </span>
        </div>
        <div v-if="field.description" class="text-[11px] leading-snug text-fg-muted">{{ field.description }}</div>
        <!-- The required shape, shown as METADATA.
          Neither this renderer nor core executes it — core's rule is that an
          agent-supplied regex is never compiled, because uncontrolled regex
          evaluation is a resource-exhaustion vector. It exists so a human can see
          what the asking Agent expects and format their answer accordingly; the
          agent validates its own pattern against the answer it receives. -->
        <div v-if="field.pattern" data-test="interaction-pattern" class="text-[11px] text-fg-muted">
          <span class="uppercase tracking-wide">{{ t('bot.interaction.pattern') }}</span>
          <code class="ml-1">{{ field.pattern }}</code>
        </div>

        <!-- Boolean: two explicit options, not a checkbox, so the user answers the
          question rather than toggling a state. -->
        <div v-if="field.kind === 'boolean'" class="flex gap-2">
          <button
            v-for="option in [true, false]"
            :key="String(option)"
            type="button"
            class="rounded border border-border px-3 py-1 text-xs transition-colors"
            :class="String(hasAnswer(answers, field.key) ? answers[field.key] : '') === String(option)
              ? 'border-accent bg-accent/10 text-accent'
              : 'text-fg hover:bg-surface'"
            @click="emit('answer', field.key, option)"
          >
            {{ option ? t('bot.interaction.yes') : t('bot.interaction.no') }}
          </button>
        </div>

        <!-- Select: the option VALUE is the answer, so the label can be anything
          the agent wrote. The current selection is always visible. -->
        <select
          v-else-if="field.kind === 'single-select'"
          :id="controlName(index, field)"
          :data-test="`interaction-select-${field.key}`"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :value="String(hasAnswer(answers, field.key) ? answers[field.key] : '')"
          @change="onSelect(field, $event)"
        >
          <option value="" disabled>{{ t('bot.interaction.choose') }}</option>
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <!-- Multi-select: the answer is a string[] of option VALUES, so the
          renderer must produce an array. A single value here would be rejected by
          core after the form had already closed. -->
        <div v-else-if="field.kind === 'multi-select'" class="space-y-1">
          <button
            v-for="option in field.options ?? []"
            :key="option.value"
            type="button"
            :data-test="`interaction-multi-${option.value}`"
            class="mr-1 mb-1 rounded border px-2 py-1 text-xs transition-colors"
            :class="(Array.isArray(hasAnswer(answers, field.key) ? answers[field.key] : undefined) ? answers[field.key] as string[] : []).includes(option.value)
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-fg hover:bg-surface'"
            @click="onMultiToggle(field, option.value)"
          >
            {{ option.label }}
          </button>
        </div>

        <!-- Number: `inputmode` and `type=number` so a numeric keyboard appears,
          but the value is COERCED in the handler — `type=number` alone still hands
          back a string on some platforms. -->
        <input
          v-else-if="field.kind === 'number'"
          :id="controlName(index, field)"
          :data-test="`interaction-input-${field.key}`"
          type="number"
          inputmode="decimal"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :placeholder="field.title"
          :value="String(hasAnswer(answers, field.key) ? answers[field.key] : field.defaultValue ?? '')"
          @input="onNumberInput(field, $event)"
        />

        <!-- Everything else is free text; the answer is sent verbatim for core to
          validate, because the renderer is not the authority on schema rules. -->
        <input
          v-else
          :id="controlName(index, field)"
          :data-test="`interaction-input-${field.key}`"
          type="text"
          class="w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-fg"
          :placeholder="field.title"
          :value="String(hasAnswer(answers, field.key) ? answers[field.key] : field.defaultValue ?? '')"
          @input="onTextInput(field, $event)"
        />
      </div>

      <!-- Field-level problems the renderer can see. Surfaced BEFORE Submit, while
        the form is still open: the interaction resolves on submit, so an answer
        core rejects afterwards is one the user cannot correct. -->
      <div v-if="invalidFields.length > 0" data-test="interaction-invalid" class="text-[11px] text-danger">
        <div v-for="entry in invalidFields" :key="entry.field.key">
          {{ t('bot.interaction.fieldInvalid', {
            title: entry.field.title,
            problem: entry.problems.map(problemLabel).join(', '),
          }) }}
        </div>
      </div>

      <div v-if="requiredMissing.length > 0" class="text-[11px] text-warning">
        {{ t('bot.interaction.requiredMissing', { fields: requiredMissing.map((f) => f.title).join(', ') }) }}
      </div>

      <div v-if="errorCode" data-test="interaction-error" class="text-[11px] font-medium text-danger">
        {{ errorCode === 'interactionGone' ? t('bot.interaction.errorGone')
          : errorCode === 'connectorOutdated' ? t('bot.interaction.errorOutdated')
          : t('bot.interaction.errorFailed') }}
      </div>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          data-test="interaction-submit"
          class="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition-opacity disabled:opacity-50"
          :disabled="submitting || requiredMissing.length > 0 || !canSubmit"
          @click="emit('submit')"
        >
          <Loader2 v-if="submitting" :size="12" class="animate-spin" />
          <Check v-else :size="12" />
          <span>{{ t('bot.interaction.submit') }}</span>
        </button>
        <button
          type="button"
          data-test="interaction-decline"
          class="rounded border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 disabled:opacity-50"
          :disabled="submitting"
          @click="emit('decline')"
        >
          {{ t('bot.interaction.decline') }}
        </button>
        <button
          type="button"
          data-test="interaction-cancel"
          class="rounded border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface disabled:opacity-50"
          :disabled="submitting"
          @click="emit('cancel')"
        >
          {{ t('bot.interaction.cancel') }}
        </button>
      </div>
    </template>
  </div>
</template>
