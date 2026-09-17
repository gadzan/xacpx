# Attaching to a Local Agent's Native Session (/ssn)

> The README keeps only the basic entry point; this document explains the full semantics, usage flow, and troubleshooting of `/ssn` / `/ss native`. For the complete command quick-reference, see [commands.md](./commands.md).

## In One Sentence

`/ssn` is used to attach an **existing native session** of an Agent such as Codex on your local machine into xacpx. After attaching, when you continue sending plain messages in WeChat, Feishu, or Yuanbao, the messages continue to enter the same Agent native session, rather than copying out a new context.

For everyday use, just remember these two kinds of commands:

```text
/ss codex --ws project       # Create or reuse an xacpx logical session
/ssn codex --ws project      # Query and attach to a local Codex native session
```

## When to Use `/ss`, When to Use `/ssn`

| Scenario | Recommended Command |
|------|----------|
| Start a brand-new remote work session from your phone | `/ss codex -d /path/to/repo` |
| Switch back to an existing xacpx session | `/ss` then `/use <alias>` |
| Attach to a native session that already exists in the local Codex/Agent CLI | `/ssn codex -d /path/to/repo` |
| List the local native sessions under the same agent and same workspace as the current session | `/ssn` |
| You already know the native `sessionId` and want to attach it directly into xacpx | `/ssn attach <sessionId> -a <alias>` |

`/ss` will not actively enumerate or attach new native sessions; it only manages xacpx logical sessions. After attaching via `/ssn`, an ordinary xacpx logical session alias is generated (for example `codex-e8e552e7`), which you can later see in the `/ss` list and switch back to with `/session use <alias>`.

## Prerequisites

- The `acpx` version on your machine needs to support agent-side session querying and resumption.
- The corresponding Agent must also support native session listing/resumption; if the Agent does not support it, xacpx will prompt you to keep using `/ss`.
- If you use `--ws <name>`, that workspace must already exist in the xacpx configuration; you can also use `-d /absolute/path` directly.

## Common Flows

### 1. Query by workspace and Auto-attach

```text
/ssn codex --ws project
```

If only one candidate is found, xacpx will directly attach and switch to that session. The default alias is:

```text
<agent>-<last 8 characters of sessionId>
```

For example `codex-e8e552e7`. The workspace is already determined by the `/ssn` query context, and the alias preferentially highlights the trailing digits of the native sessionId, making it easy to correspond with the `ID: …e8e552e7` in the list. If this alias or the corresponding underlying transport session name is already taken, xacpx will automatically append `-2`, `-3` to avoid overwriting an existing session.

### 2. With Multiple Candidates, Pick a Number First

```text
/ssn codex --ws project
/ssn 1
```

The first command lists candidates and caches a short-lived list; `/ssn 1`, `/ssn 2` will select the corresponding item from the most recent list. If the list has expired or been overwritten by a new query, please re-run `/ssn ...`.

To specify an alias directly at attach time, use `/ssn <number> -a <alias>`, for example `/ssn 1 -a fix-ci`. In WeChat the list only shows the trailing digits of the sessionId and you cannot see the full id, so specifying an alias by number is handier than `/ssn attach <sessionId> -a ...`.

### 3. Query Directly by Path

```text
/ssn codex -d /Users/me/project
```

This suits projects that have not yet registered a workspace. xacpx will resolve or create an internal workspace context by path, and bind the attached logical session to that path.

### 4. Attach Directly by Native sessionId

```text
/ssn attach 019e5d48 -a fix-ci
```

This attaches the specified `sessionId` according to the context of the most recent `/ssn` query, and sets the xacpx logical session alias to `fix-ci`. If there is no context yet, please run once first:

```text
/ssn codex --ws project
```

The long form is equivalent:

```text
/ss attach native 019e5d48 -a fix-ci
```

### 5. View More or Query Across cwd

By default `/ssn codex --ws project` only looks at the native sessions under that working directory. When you need to query across cwd, add `--all`:

```text
/ssn codex --ws project --all
```

If the underlying layer returns paginated results, a "more" command will be given at the end of the list; just copy and send it.

## Behavior After Attaching

After a successful attach, xacpx creates a logical session that points to this native session:

- Plain messages continue to be sent to the same Agent native session.
- `/use <alias>`, `/sessions`, `/status`, etc. still work in terms of the xacpx logical session.
- `/session rm <alias>` only deletes the logical mapping inside xacpx; it does not equal deleting the Agent native session.
- When the same native session is selected by `/ssn` again, xacpx will preferentially switch back to the already-attached **ordinary** logical session, avoiding duplicate creation. Native IDs already bound to a product-owned (Bot/Group) hidden runtime are omitted from the public native catalog and cannot be attached as an ordinary Session; submitting such an ID fails `hidden_session` rather than remounting the same model context. Ownership keys on cwd plus the physical agent selector (unwrapped argv, raw command, or bare positional agent), so a guarded Bot runtime, an unguarded native picker, and two config agents that share argv or raw command still occupy the same catalog. A managed overlay identity whose argv is missing is unproven: historical `agentCommand` is not treated as a raw `--agent` selector, and attach fail-closes rather than guessing a different catalog.

## Command Quick-reference

| Command | Description |
|------|------|
| `/ssn` | View local native sessions using the current xacpx session context |
| `/ssn codex --ws project` | Query the Codex native sessions under the specified workspace |
| `/ssn codex -d /Users/me/project` | Query by absolute local path |
| `/ssn codex --ws project --all` | Query that agent's native sessions across cwd |
| `/ssn 1` | Attach to or switch to the 1st candidate in the list |
| `/ssn 1 -a <alias>` | Attach to the 1st candidate in the list and specify an xacpx alias (use this when you cannot see the full id in WeChat) |
| `/ssn attach <sessionId> -a <alias>` | Attach by native sessionId and specify an xacpx alias (suitable when you know the full id) |
| `/ss attach native <sessionId> -a <alias>` | The long form of `/ssn attach` |
| `/help ssn` | View the concise help inside the chat |

## FAQ

### What is the Relationship Between `/ssn` and `/ss native`?

`/ssn` is the recommended short command; `/ss native ...` is the explicit form of the same capability. For everyday use, prefer remembering `/ssn`.

### Why Didn't `/ssn codex` Auto-attach the Only Candidate?

When you write only the agent, the scope is not specific enough, so xacpx will show a list rather than auto-attach. To auto-attach the only candidate, please explicitly specify a workspace or path:

```text
/ssn codex --ws project
/ssn codex -d /Users/me/project
```

### Why Does It Say "The current transport does not support listing local sessions"?

It means the current transport, `acpx`, or Agent cannot currently query native sessions. You can still use `/ss codex -d /path/to/repo` to manage ordinary xacpx sessions.

### Will a Failed Attach Affect the Original xacpx Session?

xacpx checks the alias and the underlying transport session name before attaching, doing its best to avoid overwriting an existing mapping. If there is a conflict, it will automatically assign a suffixed alias, for example `codex-e8e552e7-2`.

### After Chatting a Few Rounds on My Phone, Will the Local Agent Native Session Have These Records?

Yes. `/ssn` resumes and continues the same Agent native session, not just copying the context and opening another private xacpx copy. Whether the full records can specifically be seen in the local CLI depends on that Agent's own session display capability.
