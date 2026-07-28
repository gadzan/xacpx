# Subagent Card: Traceless Activity & Result Presentation

## Problem Statement

Relay Web's subagent card renders a live child-tool timeline only for adapters that emit parent links (Claude). Qoder, Kimi, and Codex delegations never produce `parentToolCallId`, so their cards spend the whole run with an empty timeline. The current stopgap shows the last line of the step's detail text or a "running, no activity details yet" message, and the card still surfaces trace-shaped affordances — "0 activity steps" and a full-trace dialog whose timeline section is empty — that promise data which will never arrive.

The deeper gap is upstream: for `think`-kind Agent tools, connector normalization (`packages/channel-relay/src/tool-presentation.ts`) builds the detail exclusively from the tool *input* (the delegated prompt). The subagent's streamed output and final report — which ACP does deliver on the parent Agent tool call via content blocks / `rawOutput` — are dropped before they reach the wire. The web card therefore cannot show progress or results for these adapters even though the data exists at the connector boundary.

## Solution

A provider-agnostic, three-part progressive enhancement. The card treats a real child trace as an optional upgrade, not a requirement:

1. **Surface the output stream as activity.** The connector always carries both the delegated prompt and the latest output text on subagent steps. While running without children, the card's activity strip shows a live tail of the output stream with a client-side heartbeat ("updated Ns ago") and elapsed time; the expanded view shows a scrolling stream block.
2. **Capability-aware degraded UI.** Trace-shaped affordances (activity-step count, timeline, empty-timeline placeholder) appear only when children actually exist. Without children the card presents status + elapsed + stream tail — no false promises.
3. **Render the final report.** When the step finishes, its output text is rendered as sanitized markdown ("result report") in the expanded view and the trace dialog, for both live turns and persisted history.

Adapters with real parent links (Claude) keep the existing timeline presentation unchanged; when both a trace and output text exist, the trace wins in the activity strip and the report is additive in expanded/dialog views.

## User Stories

1. As a Qoder/Kimi/Codex user, I want the subagent card to show what the delegate is producing while it runs, so that the card feels alive without a child timeline.
2. As a user, I want the card to stop advertising "0 activity steps" and an empty trace view when no trace exists, so that the UI stays truthful.
3. As a user, I want the subagent's final report rendered as markdown when the run finishes, so that I can read the delegation result without digging into raw payloads.
4. As a user, I want elapsed time and a last-update heartbeat while a traceless delegation runs, so that I can tell a live run from a stalled one.
5. As a Claude user, I want the existing child-tool timeline behavior to remain unchanged, so that the richest integration does not regress.
6. As a user viewing history, I want finished subagent rows to render the same report presentation, so that live and historical views agree.
7. As a maintainer, I want the web to stay provider-agnostic (keyed on data presence, not driver names), so that Vue components accumulate no adapter branches.
8. As a maintainer, I want older connectors (that don't send output text) to degrade to the current behavior, so that the rollout is backward compatible in both directions.

## Implementation Decisions

- **Protocol** (`packages/relay-protocol`): extend the `text` detail variant with an optional `output?: string` field. An optional field keeps the wire backward compatible: old connectors simply omit it; old web builds ignore it and still render the prompt. Update the DTO validators accordingly. No new detail type — a new type would render as nothing on older clients (fail-closed), while an extended `text` fails open.
- **Connector** (`packages/channel-relay/src/tool-presentation.ts`): for `event.isSubagent` steps, normalize independently of `kind`: `detail = { type: "text", text: <delegated prompt>, output: <latest output text> }` where prompt comes from the existing input extraction and output from the existing block/`rawOutput` extraction chain (`textFromBlocks ?? stdout ?? formatted_output ?? text ?? scalar rawOutput`). Both capped at `TEXT_CAP`. Non-subagent `think` steps keep their current shape.
- **Hub**: no changes. `TOOL_DETAIL_CAP` deep-caps all strings generically, so the new field is already guarded.
- **Web `SubagentStepCard`**: derive `hasTrace = children.length > 0`.
  - With trace: presentation unchanged (timeline, rotation, trace count).
  - Without trace, running: activity strip shows the last non-empty line of `detail.output` (fallback: prompt), plus heartbeat and elapsed time. Heartbeat/elapsed are client-side (`first seen` / `last changed` timestamps tracked per `toolCallId` in the component); approximate and reset on reload is acceptable — history rows are never running.
  - Without trace, expanded: delegated prompt as a one-line collapsed row + output stream block (mono, capped height, stick-to-end while running); once finished, the same block switches to sanitized markdown via the existing `renderMarkdown` pipeline.
  - The "{count} activity steps" label renders only when `hasTrace`; otherwise the subline shows status (+ elapsed while running).
- **Web `SubagentTraceDialog`**: keep the delegated-task section; add a result section (markdown when finished, mono tail while running). The empty-timeline placeholder is removed — without children the dialog shows prompt + result instead of a spinner promising a trace.
- **Markdown safety**: reuse the existing `renderMarkdown` (markdown-it `html:false` + DOMPurify) — no new sanitization path.
- **i18n**: new keys (e.g. result-report heading, elapsed/heartbeat labels) added to both `en` and `zh-CN`.
- Update `docs/relay-web-module.md` (card behavior) and `docs/relay-module.md` (connector normalization) alongside the code.

## Testing Decisions

- Connector unit tests: captured Qoder/Kimi/Codex subagent event shapes assert prompt + output land in the extended text detail, with caps applied; a Claude Agent step keeps parent links and gains output text without regressing existing assertions.
- Protocol validator tests: extended `text` variant accepts/round-trips `output`; absence of `output` remains valid.
- Web component tests (Vitest): traceless running card shows output tail + heartbeat; traceless finished card renders the markdown report; trace-present card is byte-for-byte the current presentation; dialog shows prompt + result and no empty-timeline placeholder; history-row rendering of a finished subagent step.
- Full gates: `bun run test:web`, `npm run test:unit`, `npx tsc --noEmit`, `vue-tsc --noEmit` in relay-web.
- Manual verification against a live Qoder or Kimi delegation before release (streamed tail actually updates turn-by-turn).

## Out of Scope

- Synthesizing child-tool timelines or time-window attribution of orphan tool calls (misleading under parallelism).
- Upstream acpx/core parent-link enrichment per driver (tracked separately as a long-term option).
- Per-driver capability flags in Relay Web — capability is inferred from data presence only.
- WeChat/Feishu channel subagent presentation changes.
- Changing the subagent classification contract (`isSubagent` / `parentToolCallId`) established by the 2026-07-23 unified subagent presentation spec.

## Further Notes

- Builds on `docs/superpowers/specs/2026-07-23-unified-subagent-presentation-spec.md`, which unified classification but deliberately deferred traceless presentation.
- Whether Qoder/Kimi stream *incremental* output on the parent Agent call (vs. a single final frame) varies by adapter version; the design is valid either way — a single final frame simply means the strip shows the prompt until the report arrives.
- The 2026-07-28 stopgap (detail-snippet fallback + "running, no activity details yet" copy) is superseded by this spec but remains the degraded rendering for old connectors that never send `output`.
