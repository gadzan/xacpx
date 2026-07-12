# `src/commands` Module Notes

## Module Goal

`src/commands` is responsible for converting text commands received on the WeChat side into actions executable within the system.

It solves just three things:
- **Recognizing commands**: parsing inputs like `/session new ...` and `/agent add ...` into structured commands.
- **Routing commands**: dispatching to the corresponding handler by command type.
- **Returning results**: organizing execution results into a unified text response.

In one sentence: this is the **command entry layer**, not the business storage layer, and not the transport implementation layer.

## Position in the Overall Architecture

The call chain is roughly:

`WeChat message -> console-agent -> CommandRouter -> handler -> SessionService / SessionTransport / ConfigStore -> text response`

The responsibility boundaries here are:
- `src/commands` is responsible for "**what the user said, and who to call**".
- `src/sessions` is responsible for "**how logical sessions are stored and switched**".
- `src/transport` is responsible for "**how to communicate with the acpx session**".
- `src/config` is responsible for "**how Agent / workspace / transport config is read and written**".

## Directory Structure

### `command-router.ts`
The module's main entry.

Responsibilities:
- Call `parseCommand()` to parse the input.
- Do the overall dispatch based on `command.kind` (the 54-case switch).
- Assemble the context and ops the handler needs (the `createXxxOps` factories).
- Compose and delegate to `TransportInvoker` and `SessionControlService` (see below); keep public forwarders for the session-CRUD methods.

You can think of it as: **a thin router + a composition root**. The transport-call
wrapping and the session-CRUD-with-transport logic were extracted into the two
units below; the router no longer owns them, it just wires them into the handlers'
ops and forwards the CRUD calls.

### `transport-invoker.ts`
`TransportInvoker` — the transport-call wrapping layer. Wraps every `SessionTransport`
call with perf/timing logging, progress-heartbeat, cooperative abort, and error
diagnostics.

Responsibilities:
- `ensureTransportSession` / `checkTransportSession` (with `createProgressHandler`
  heartbeat + auto-install recovery of missing optional deps).
- `promptTransportSession` (abort-before-dispatch handling, perf marks).
- `setMode` / `setModel` / `getModel` / `cancelTransportSession`.
- `refreshSessionTransportAgentCommand`.
- `measureTransportCall` (the shared timing + success/failure log + `PromptCommandError`
  diagnostic wrapper).

Holds no session-CRUD or dispatch state. The router constructs one and the
`createSessionLifecycleOps`/`createSessionInteractionOps`/… factories delegate to it.

### `session-control-service.ts`
`SessionControlService` — the session-CRUD-with-transport lifecycle, coordinating
`SessionService` + `SessionTransport` + `OrchestrationService`.

Responsibilities:
- `createSessionWithTransport` / `attachNativeSessionWithTransport` (resolve → reserve
  → ensure/resume → verify → bind → refresh, best-effort refresh).
- `removeSessionWithTransport` (orchestration blocking-task guard → logical remove →
  best-effort reference purge → transport delete only when no other alias shares it).
- `archiveSessionWithTransport` (active-turn guard → cancel + free warm process when
  unshared → flag archived) / `unarchiveSession`.
- `listNativeSessionsForControl`.

Composes a `TransportInvoker` (uses its `ensureTransportSession`/`checkTransportSession`/
`refreshSessionTransportAgentCommand`) and takes `reserveLogicalTransportSession` as an
injected callback. The router keeps byte-identical public forwarders for all six methods,
so `main.ts` / control API / `console-agent.ts` call sites are unchanged.

Both units are guarded by a black-box golden oracle
(`tests/unit/commands/golden/`) that records the router's ordered collaborator-call
log; see the oracle test for the covered scenarios.

### `parse-command.ts`
The command parser.

Responsibilities:
- Recognize slash commands.
- Extract arguments, options, and prompt text.
- Output a unified command structure for the routing layer to consume.

It is only responsible for "**understanding the input**", not for execution.

### `handlers/`
Command handlers split by responsibility.

Currently it mainly includes:
- `help-handler.ts`: the help command.
- `agent-handler.ts`: Agent config management.
- `workspace-handler.ts`: workspace config management.
- `permission-handler.ts`: permission-related commands.
- `session-handler.ts`: the entry to the main session flow, such as create, switch, status, prompt, cancel.
- `session-shortcut-handler.ts`: the session shortcut create/switch flow.
- `session-recovery-handler.ts`: session recovery and error rendering.
- `session-reset-handler.ts`: the session reset flow.

The splitting principle is not piling up files by command name, but splitting by **responsibility boundary**:
- The main flow
- The shortcut flow
- The recovery logic
- The reset logic
- Config-type commands

The purpose of this is to reduce coupling between `command-router.ts` and a single large handler.

### `router-types.ts`
Shared type definitions for the routing layer.

Responsibilities:
- Define `RouterResponse`.
- Define `CommandRouterContext`.
- Define various session ops interfaces, such as lifecycle, interaction, recovery, reset, shortcut.

Its value is making "**what capabilities the router depends on**" explicit, rather than scattering it across the individual handlers.

### `transport-diagnostics.ts`
A transport error diagnostics helper.

Responsibilities:
- Extract a transport error summary.
- Extract debugging info such as ndjson / tail / partial output.
- Let the routing layer provide more stable user hints and log info when reporting errors.

It is not responsible for recovery, only for **organizing diagnostic info**.

## Processing Flow

Take a single command as an example:

1. The outer layer passes the text to `CommandRouter.handle()`.
2. `parseCommand()` parses out the `kind` and arguments.
3. `command-router.ts` selects the corresponding handler by `kind`.
4. The handler calls the underlying services:
   - Session state goes through `SessionService`
   - acpx interaction goes through `SessionTransport`
   - Config changes go through `ConfigStore`
5. The handler returns a unified `{ text }`.
6. The outer layer sends the text back to WeChat.

## Design Principles

This module follows a few principles:

- **Separation of parsing and execution**: `parse-command.ts` does not do business execution.
- **Separation of routing and implementation**: `command-router.ts` is only responsible for dispatch and assembly, not stuffed full of business details.
- **Error recovery is consolidated separately**: recovery logic is placed in a dedicated handler, not scattered across the main flow.
- **Dependency capabilities are made explicit**: `router-types.ts` splits session-related capabilities into small interfaces.
- **Unified responses**: the routing layer uniformly returns a `RouterResponse`, making it easy for the upper layer to consume.

## Code That Belongs Here

Code suitable for `src/commands`:
- New slash command parsing rules.
- New command routing dispatch.
- The organization of text responses for a certain class of command.
- Lightweight orchestration logic directly related to command execution.

Code not suitable here:
- Session-state persistence details.
- acpx process or bridge protocol details.
- Config-file read/write details.
- General business logic unrelated to commands.

The criterion is just one sentence: if the code answers "**how should this command be handled**", it usually belongs here; if it answers "**how is the underlying capability specifically implemented**", it usually does not belong here.

## Modification Suggestions

If you continue to extend commands later, it's recommended to change things in the following order:

1. First define the input shape in `parse-command.ts`.
2. Then add or extend the corresponding handler.
3. Finally wire the dispatch into `command-router.ts`.

If a command starts to contain:
- A main flow
- A recovery flow
- A reset/retry flow
- Dedicated rendering logic

then it should be split into a standalone handler as early as possible — don't keep piling it into the same file.
