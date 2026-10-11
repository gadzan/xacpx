# Issue #399: Direct completion implementation evidence

This implements the same-instance V1 contract in [Issue #399](https://github.com/gadzan/xacpx/issues/399). It does not publish packages, deploy, or edit user configuration.

## P0 findings and implementation map

| Existing gap verified in source | Implementation entry | Evidence |
| --- | --- | --- |
| Direct composer had no menus and discarded text after emitting | relay-web ConversationPromptInput, direct-composer, composer-completion | Direct completion/component tests and desktop/mobile E2E |
| Conversation prompt DTO/sanitizer/runner did not preserve references | relay-protocol agent-mentions; Control DTO/public sanitizer; Run service, SQLite, dispatcher, runner/port/TurnQueue | Protocol validation, Control replay/reopen and invalid-target tests |
| Ordinary sender directory could not safely grant a product-owned Direct sender | conversations/direct-messaging and private execution metadata; session-handler; MCP registry | Actual ConsoleAgent/CommandRouter fake-transport A to cold B test |
| Receiver path was tied to ordinary Session messaging | ensurePeerTopic and existing Direct admission/dispatcher | Private Topic/history/Run rejection, bot-role durable request, single durable replay |
| No first-turn Direct command discovery | Control getConversationCompletions; BotRuntimeManager prepareDirectSession; transport and bridge engines | Coalesced cold queries with no prompt/message/Run; adapter status tests |

There is one durable Conversation scheduler and one existing runtime/transport owner path. The new registry is an authorization adapter, not another executor.

## Permission matrix

| Surface | Unrestricted live Direct | Group | Restricted read-only | Public caller/cold discovery |
| --- | --- | --- | --- | --- |
| Structured reference | Authorized identity, no new authority | Reject nonempty Direct references | Reject references | May submit only validated ranges/opaque handles |
| MCP tools | agent_list and agent_send | group_send only | None | No execution capability |
| Sender identity | Core-derived live Run/member/dispatch/session binding | Existing Group binding | Cannot send | Cannot mint by text/token/metadata |
| Receiving scope | Private per-source Conversation/Topic + target Bot | Existing Group contract | Existing policy ceiling | Cannot prompt/read/cancel private peer Topics |
| Human permission | Only existing trusted human ingress | Existing origin rules | Existing ceiling | A reference never provides approval |

Tool invocation rechecks enabled/lifecycle, exact ownership, logical session, Topic generation, dispatch owner/generation/lease, and current member/run state. Receiver admission fences them again immediately before its commit. The registry used for menu, list, mention admission, and send is the same same-instance Bot authorization implementation. Cross-instance/offline handles fail explicitly.

## Durable migration and replay

SQLite messages gains nullable input_metadata_json using an additive PRAGMA/ALTER migration. Version 1 carries resolved mention snapshots and/or core-private peer provenance; no bearer capability is stored. Legacy NULL rows are no-reference input. Invalid versions/keys/ranges or mismatched peer sender/role are rejected. Topic peerScope persists the source Conversation/Topic/Bot, with a stable hashed private Topic ID; it is never derived from display names or hidden aliases.

Exact requestId replay compares original text and raw references and remains valid after a target is disabled; a new admission or execution revalidates the frozen target. This preserves accepted-request recovery rather than resolving a replacement with the same label. Reference target Bot/agent/workspace changes fail closed before provider execution.

## Cold discovery and compatibility

RuntimeEngine ensures/loads the owned ACP session and reads acpx status.availableCommands without a prompt. CLI/legacy bridge transports can expose commands only if their status JSON provides an availableCommands array; omission means unavailable, never a fabricated empty ready list. kind=skill is preserved only when explicitly advertised. No global skills, shell/WeChat management commands, or extra Group tools are added.

Identical prepares share an in-flight promise and the existing Bot lifecycle/materialization gate. The 10-second query budget returns loading; it does not release ownership while the original transport initialization is still pending. Retry joins that work, and shutdown drains entered operations. Real execution rotates the immutable MCP identity through the existing worker ownership path. Profile/adapter context/Topic generation key cached results; command epochs suppress retired callbacks. Cancellation, failed/terminal dispatch, or lease replacement prevents the Direct sender from remaining valid.

New selection requires a version=1 completion response. A newer connector rejects references against an older daemon with no completion API. Older clients may send ordinary text; missing metadata is equivalent to no references. revision invalidates projections and is never an authorization credential.

## V1 delivery limits

Receipts mean durable queued admission, not completed work or a reply. Supported mode is queue/auto; steer/interrupt/completion/conversation/replyTo are unavailable. Targets are enabled receiving Bots on the same online instance, including cold Bots. Private peer streams and product events do not enter public Direct histories or Relay reconnect snapshots. The explicit message only is transferred, with minimal source provenance and no inherited human ingress. No Task or offline mailbox is created. Content is capped at 16000 bytes, depth at 8 and distinct messages at 16 per execution; simple ACK loops are rejected.

## Validation and remaining environment checks

Focused backend verification: 280 passing tests across 11 files covering protocol, SQLite, Control API, production composition, MCP/Relay boundaries, advertised prompt handling and CLI/streaming adapter status. Root TypeScript and Vue TypeScript checks passed with Node 22.20.0. All workspace packages built successfully. The affected Web suites passed 251 tests; desktop and mobile Playwright checks both passed using installed Chrome. The final full Web suite result is recorded in the PR.

The full unit suite was attempted but Windows-native command wrappers/process identity tests fail in this environment; a broader attempt also exhausted memory. Package build was retried successfully with supported Node and bounded verification concurrency. Initial full Web attempts exposed an acceptance-recovery state regression; it was fixed and all affected suites passed, with a final full run used to verify the complete Web result. Chromium download ran out of space, so E2E used installed Chrome instead.

Real Codex/Claude authenticated smoke, adapter-specific Skill advertising, and WeChat smoke are not run without the required credentials/infrastructure. Fake adapters prove UI, durable admission, actual ConsoleAgent transport delivery, and advertised-command interpretation deterministically; they cannot guarantee that a real model elects to call agent_send. Unsupported pre-prompt adapter discovery remains explicitly unavailable.
