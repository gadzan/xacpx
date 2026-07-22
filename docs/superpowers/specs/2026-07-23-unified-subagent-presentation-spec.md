## Problem Statement

Relay Web renders Claude delegated work as a dedicated subagent card, but equivalent delegation from Qoder, Kimi, and Codex appears as ordinary tool calls. Each ACP adapter emits a different provider-specific shape, and the current transport normalization only recognizes Claude metadata. Users therefore see inconsistent message presentation for the same intent and cannot reliably distinguish delegated work from ordinary tools.

Captured production traces show that Qoder identifies its `Agent` tool in namespaced metadata, Kimi exposes a completed Agent call through merged semantic input, and Codex emits namespaced subagent thread/activity metadata. These signals are sufficient to classify the parent delegation consistently, but only Claude currently supplies parent links for child tool activity. The UI must not invent a trace that the adapter did not emit.

## Solution

Normalize provider-specific subagent signals at the transport boundary after sparse ACP tool updates have been merged. The normalized `ToolUseEvent` will mark delegated parent tools with `isSubagent`, preserve any real parent relationship, and retain the adapter's actual lifecycle status and output.

Relay and Relay Web will remain provider-agnostic. Existing subagent DTO fields and the existing subagent card will render all recognized delegated work consistently. When an adapter does not expose child tool events, the card will show the delegated task and available result without fabricating timeline entries.

## User Stories

1. As a Relay Web user, I want Claude, Qoder, Kimi, and Codex delegations to use the same subagent card, so that identical actions look consistent across agents.
2. As a Relay Web user, I want delegated work to be visually distinct from ordinary tools, so that I can scan a turn quickly.
3. As a Qoder user, I want the namespaced Agent signal to be recognized, so that its delegation is not rendered as a generic thinking tool.
4. As a Kimi user, I want its incrementally streamed Agent call to become a subagent card once the semantic input is available, so that sparse early frames do not prevent correct classification.
5. As a Codex user, I want namespaced subagent activity to be recognized, so that a spawned Codex thread is presented as delegated work.
6. As a Claude user, I want the existing nested subagent trace behavior to remain unchanged, so that this generalization does not regress the richest adapter integration.
7. As a user of an adapter without child-tool events, I want the UI to avoid invented activity, so that the presentation remains truthful.
8. As a user viewing historical or sparse tool events, I want ordinary tools without a positive subagent signal to keep their existing presentation, so that classification is fail-safe.
9. As a custom-agent user, I want provider-specific recognition to be gated by the resolved driver, so that coincidental tool titles or input field names do not create false subagent cards.
10. As a maintainer, I want provider-specific knowledge contained in transport normalization, so that Relay protocol and Vue components do not accumulate adapter branches.
11. As a maintainer, I want captured adapter shapes covered by deterministic replay tests, so that adapter format drift is visible during development.
12. As a maintainer, I want both direct CLI and bridge transports to use the same normalization path, so that deployment topology does not change presentation.
13. As a maintainer, I want existing raw input, output, content, and status preserved, so that the unified card does not discard diagnostic information.
14. As a maintainer, I want unknown or malformed provider metadata to remain an ordinary tool event, so that format drift fails open rather than misclassifying tools.

## Implementation Decisions

- Add a provider-aware subagent classification seam to the shared streaming tool-event normalization path.
- Pass the resolved ACP driver into streaming normalization for both direct CLI and bridge execution paths; custom agent aliases use their resolved driver rather than their display name.
- Classify Claude delegation from its existing namespaced Agent metadata and retain its existing parent-tool mapping and asynchronous lifecycle behavior.
- Classify Qoder delegation only when the resolved driver is Qoder and its namespaced metadata positively identifies the Agent tool.
- Classify Kimi delegation only when the resolved driver is Kimi and the merged tool state contains the semantic Agent input shape, including a non-empty prompt and subagent type. A generic title by itself is not sufficient.
- Classify Codex delegation only when the resolved driver is Codex and namespaced Codex subagent metadata contains positive thread/activity identity.
- Perform classification after sparse updates are merged so that Kimi can be recognized from its later rich frame and Qoder metadata survives its sparse terminal frame.
- Generalize metadata typing and merging only as necessary to preserve the recognized provider namespaces; do not expose provider-specific metadata through Relay DTOs.
- Continue emitting the existing normalized `isSubagent` and `parentToolCallId` contract. No provider branch is added to Relay Web.
- Preserve the ACP tool status. A completed Codex launch activity is presented as a completed launch; it is not reinterpreted as proof that an unobserved child execution trace completed.
- Preserve existing behavior for ordinary tools and adapters without a positive recognized signal.
- Update the Relay Web module documentation before recording any new navigation in repository-level instructions. No new repository navigation entry is expected because the subsystem already has one.

## Testing Decisions

- The primary test seam is captured ACP event replay through the shared streaming parser, asserting the externally visible normalized `ToolUseEvent` rather than private classifier helpers.
- Representative Claude, Qoder, Kimi, and Codex event sequences will be covered, including sparse terminal updates and incremental Kimi input.
- Tests will assert positive classification, final status, useful title/summary preservation, and absence of fabricated parent links.
- Negative tests will prove that Kimi-like titles without the driver-gated semantic input and malformed provider metadata remain ordinary tools.
- Existing Relay protocol and Relay Web subagent-card tests serve as prior art and continue to verify that an `isSubagent` event is preserved and rendered by the common card.
- Direct CLI and bridge call-site tests or type checks will verify that resolved driver identity reaches the shared parser in both paths.
- Run the focused streaming parser tests during development, TypeScript checking regularly, and the complete unit test suite at the end.

## Out of Scope

- Synthesizing child-tool timelines when an ACP adapter does not emit child events or parent relationships.
- Reading Qoder, Kimi, or Codex private transcript stores to reconstruct missing activity.
- Changing ACP adapter packages or proposing a cross-vendor ACP standard.
- Redesigning the existing subagent card, trace dialog, or Relay wire protocol.
- Treating arbitrary tools named `Agent`, `Task`, or `spawn_agent` as subagents without a driver-gated positive signal.
- Changing session-list filtering for native Codex subagent threads.

## Further Notes

- The captured traces used to define this behavior were recorded on 2026-07-22 from the configured Qoder, Kimi, and Codex adapters.
- Qoder and Kimi expose a complete parent Agent tool result but no child-tool ownership links in the parent ACP stream.
- Codex exposes a subagent thread identifier in the parent ACP stream, while the child result is stored in a separate rollout. This spec deliberately unifies presentation without coupling the transport to that private storage.
