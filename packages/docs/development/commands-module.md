# Commands Module

## Module goal

`src/commands` converts text commands received from chat channels into system actions.

It solves exactly three problems:
- **Recognize commands** — parse `/session new ...`, `/agent add ...`, and similar inputs into structured command objects.
- **Route commands** — dispatch by command type to the corresponding handler.
- **Return results** — format execution results as unified text responses.

This is the **command entry layer** — not a business storage layer and not a transport implementation layer.

## Responsibilities

The call chain looks like this:

```
Chat message → ConsoleAgent → CommandRouter → handler → SessionService / SessionTransport / ConfigStore → text response
```

Responsibility boundaries:

- `src/commands` answers "**what did the user say, and who handles it**."
- `src/sessions` answers "**how logical sessions are stored and switched**."
- `src/transport` answers "**how to communicate with an acpx session**."
- `src/config` answers "**how agent / workspace / transport config is read and written**."

## Parser boundary

### `parse-command.ts`

The command parser. Responsibilities:

- Recognize slash commands.
- Extract arguments, options, and prompt text.
- Output a uniform command structure for the router to consume.

The parser only **reads input** — it does not execute anything.

Alias resolution is built in: `/ss` → `/session`, `/ws` → `/workspace`, `/stop` → `/cancel`. Source: [`src/commands/parse-command.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/parse-command.ts)

## Router boundary

### `command-router.ts`

The module's main entry point. Responsibilities:

- Call `parseCommand()` to parse input.
- Dispatch based on `command.kind`.
- Assemble the context and ops required by each handler.
- Compose and delegate to `TransportInvoker` and `SessionControlService`; keep public forwarders for the session-CRUD methods.
- Catch transport errors, log them, and produce diagnostic summaries.

Think of it as a **thin router + context assembler** — not a place for business logic. The transport-call wrapping and the session-CRUD-with-transport logic were extracted into `TransportInvoker` and `SessionControlService`; the router only wires them into the handlers' ops and forwards the CRUD calls.

The handler-facing transport operations live in `TransportInvoker` ([`src/commands/transport-invoker.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/transport-invoker.ts)), not in the router:

- `ensureTransportSession()` — supports auto-install of missing optional dependencies and secondary verification.
- `promptTransportSession()` — uniformly forwards `reply` / `quota` / `media` and ensures `mcpCoordinatorSession` defaults.
- `measureTransportCall()` — records success/failure logs uniformly; extracts `stdout`/`stderr` diagnostic summaries from `PromptCommandError`.

Source: [`src/commands/command-router.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/command-router.ts)

### `router-types.ts`

Shared type definitions for the routing layer:

- `RouterResponse` — the uniform response type returned by all handlers.
- `CommandRouterContext` — context passed into handlers.
- Session ops interfaces (`SessionLifecycleOps`, `SessionInteractionOps`, `SessionRecoveryOps`, etc.).

These types make the router's capability dependencies explicit rather than scattered across individual handlers. Source: [`src/commands/router-types.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/router-types.ts)

## Handler conventions

### `handlers/`

Handlers are split by **responsibility boundary**, not by command name:

| File | Responsibility |
| --- | --- |
| `help-handler.ts` | Help commands |
| `agent-handler.ts` | Agent config management |
| `workspace-handler.ts` | Workspace config management |
| `permission-handler.ts` | Permission-related commands |
| `session-handler.ts` | Session main flow — create, switch, status, prompt, cancel |
| `session-shortcut-handler.ts` | Session shortcut create/switch flow |
| `session-recovery-handler.ts` | Session recovery and error rendering |
| `session-reset-handler.ts` | Session reset flow |
| `native-session-handler.ts` | Native session list / attach flow |
| `orchestration-handler.ts` | Orchestration commands — delegate, group, task approve/cancel |
| `later-handler.ts` | Scheduled (`/later`) delayed-task commands |
| `config-handler.ts` | Config commands — read/write config values |

The split keeps `command-router.ts` and individual large handlers loosely coupled. When a handler accumulates multiple distinct flows (main flow + recovery + reset + specialized rendering), split it into separate files early — don't keep stacking onto one file.

### Adding a new command

Follow this order:

1. Define the input shape in `parse-command.ts`.
2. Add or extend the corresponding handler in `handlers/`.
3. Register the dispatch case in `command-router.ts`.
4. Mirror tests in `tests/unit/commands/`.

### What belongs here

Code that answers "**how should this command be handled**":
- New slash command parsing rules.
- New command routing dispatch cases.
- Text response organization for a command type.
- Lightweight orchestration logic directly tied to command execution.

Code that does **not** belong here:
- Session state persistence details.
- `acpx` process or bridge protocol details.
- Config file read/write details.
- General business logic unrelated to a command.

### `transport-diagnostics.ts`

Transport error diagnostic helper. Responsibilities:
- Extract transport error summaries.
- Extract `ndjson` / tail / partial output for debugging.
- Produce stable, actionable user-facing messages and log entries when transport calls fail.

This module does not handle recovery — only diagnostic information assembly. Source: [`src/commands/transport-diagnostics.ts`](https://github.com/gadzan/xacpx/blob/main/src/commands/transport-diagnostics.ts)

## Testing notes

- Unit tests mirror `src/commands/` under `tests/unit/commands/`.
- Handler tests inject fake `SessionService`, `SessionTransport`, and `ConfigStore` implementations — handlers must not depend on concrete implementations.
- Parser tests (`parse-command.test.ts`) feed raw text strings and assert the resulting command `kind` and argument fields.
- Router tests run `CommandRouter.handle()` with a fake `reply` callback and assert on the response text and which downstream calls were made.
- Time-sensitive assertions (e.g. concurrent prompt cancellation) must use `await` on the expected promise rather than `Bun.sleep()`.

Design principles enforced by the module structure:

- **Parse and execute are separate** — `parse-command.ts` has no side effects.
- **Route and implement are separate** — `command-router.ts` dispatches and assembles, does not contain business detail.
- **Error recovery is isolated** — recovery logic lives in its own handler, not in the main flow.
- **Capability dependencies are explicit** — session ops are declared as small interfaces in `router-types.ts`.
- **Responses are uniform** — the routing layer always returns `RouterResponse`, making it easy for the caller to consume.
