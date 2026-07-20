# Windows handoff: investigate Web-created Claude session model/auth failure

You are working on the Windows machine where the bug actually reproduces. Continue investigation and implement the smallest root-cause fix in the local `xacpx` repository. Do not assume the macOS machine's Claude configuration is relevant.

## Goal

On this Windows instance, Claude Code uses a third-party Claude-compatible API. Creating a fresh Claude session from relay-web results in the session using/reporting `sonnet` instead of the intended default behavior, and the first conversation fails with an authorization error.

Determine exactly which layer selects `sonnet`, fix the underlying configuration/semantic problem, add regression coverage at the real call seam, and verify with the actual Windows instance.

Do not publish a release or push changes unless the user explicitly asks after reviewing the fix.

## Suggested skills

- `diagnosing-bugs`: required; build a deterministic red/green feedback loop before changing production code.
- `tdd`: use once the failing seam is identified.
- `codebase-design`: use if the fix requires changing model-selection or settings-source interfaces.

## Observed behavior

- Reproduction exists only on this other Windows machine.
- This Windows machine uses a third-party API for Claude Code.
- relay-web fresh-session creation appears to select/report `sonnet`, then prompting fails authorization.
- The macOS machine does not use the third-party API and cannot validate the real runtime behavior.

Record the exact authorization error text, but redact all tokens, endpoint credentials, account identifiers, and private URLs.

## Important facts already established

1. Claude Code's literal `default` is not a provider model ID. It clears a model override and returns to Claude Code's runtime/account default. For Anthropic API users that default currently resolves to Sonnet, so blindly passing `"default"` does not inherently fix third-party authorization.
   - https://code.claude.com/docs/en/model-config

2. On upstream xacpx main, relay-web currently collapses blank/`default` into an omitted model:
   - `packages/relay-web/src/components/NewSessionDialog.vue`
   - `packages/relay-web/src/stores/instances.ts`

3. Session resolution then uses:

   ```ts
   model: session.model ?? agentConfig.model
   ```

   in `src/sessions/session-service.ts`. Therefore an omitted session model means “inherit the xacpx agent model,” not necessarily “use the adapter/provider default.” If `agents.<claude-name>.model` is `sonnet`, the observed behavior is expected from the current implementation.

4. acpx intentionally isolates built-in Claude ACP sessions from Claude user settings. It normally passes:

   ```ts
   settingSources: ["project", "local"]
   ```

   User settings are included only when `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` is present in the daemon's environment. See the sibling acpx repository:
   - `../acpx/src/acp/agent-command.ts`
   - `../acpx/docs/config.md`
   - upstream PR: https://github.com/openclaw/acpx/pull/384

   If the third-party endpoint/model mapping lives in Windows user-level `~/.claude/settings.json`, native Claude Code may work while acpx-created sessions omit those settings and fall back to Sonnet.

5. `claude-agent-acp` has a possible settings-source consistency bug: its `SettingsManager` resolves all settings with `resolveSettings({ cwd })`, while its live Claude Query can receive a restricted `settingSources` list. The model it reports/calculates can therefore differ from the provider/env settings the live Query actually loaded.
   - https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/settings.ts
   - https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts

6. A macOS-only local commit `1312da6` added a Vue special case that sends `"default"` for Claude. It was never pushed and is considered a rejected tactical fix. Do not recreate it. It leaks adapter semantics into Web, overrides `AgentConfig.model`, persists a sticky session override, and can still resolve to Sonnet.

## Ranked hypotheses to test

1. Third-party provider/model configuration is in Claude user settings, which acpx excludes from the live Query.
2. `~/.xacpx/config.json` has `agents.<selected-agent>.model = "sonnet"`; Web omission inherits it.
3. The xacpx daemon environment differs from the interactive PowerShell/Claude environment, so `ANTHROPIC_*` variables or gateway routing are absent.
4. `claude-agent-acp` reports a model based on one settings set while the live Query uses another.
5. The third-party gateway receives a concrete Sonnet ID that it does not authorize because `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_MODEL`, or `modelOverrides` is missing/incorrect.

Do not lock onto hypothesis 1 without collecting evidence.

## Required diagnostic loop

Build one fast, agent-runnable pass/fail command or focused test that catches the exact wrong model selection at the real seam. Run it red before implementing a code fix.

Collect, without exposing secret values:

- xacpx, acpx, Claude Code, and managed `claude-agent-acp` versions.
- The selected xacpx agent name, driver, command source, adapter version, and whether its `model` field is present.
- Whether the relevant configuration is stored in user, project, local, or managed Claude settings.
- Presence only (not values) of relevant daemon environment variable names: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_BASE_URL`, authentication variables, and `ACPX_CLAUDE_INCLUDE_USER_SETTINGS`.
- The relay `control.sessions.create` payload: omitted model, literal `default`, or explicit model ID.
- The acpx invocation/session options and the ACP `session/new` `_meta.claudeCode.options` shape, with URLs/tokens redacted.
- The model advertised as current/available after session creation and the actual model named in the authorization error, if present.

Useful differential experiments, performed one variable at a time:

1. Fresh relay-web Claude session with the current configuration.
2. Same flow after temporarily setting `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` in the environment that launches/restarts the xacpx daemon.
3. Same flow with an explicit third-party-supported model ID.
4. If safe, compare native Claude Code and direct acpx session creation from the same PowerShell environment.

Treat the user-settings opt-in only as a diagnostic first. It can re-enable globally configured Claude plugins/hooks in a daemon context, which is why acpx disabled it by default.

## Correct semantic model if a product fix is needed

Do not model this as “Claude needs the string `default`.” There are three distinct intents:

```ts
type ModelIntent =
  | { kind: "inherit-agent" }
  | { kind: "adapter-default" }
  | { kind: "explicit"; modelId: string };
```

- `inherit-agent`: use `AgentConfig.model`; only fall through to adapter default when no agent model exists.
- `adapter-default`: explicitly suppress `AgentConfig.model`; transport omits a model and lets the adapter choose.
- `explicit`: use an exact model/alias selected by the user.

The Web should express intent and never branch on `driver === "claude"`. Control/session state should preserve the tri-state until it resolves the effective model. acpx/adapter should own Claude aliases and provider mappings.

A backward-compatible stored representation could be `string | null | undefined`, where `undefined = inherit`, `null = adapter-default`, and `string = explicit`, but only use this if tests clearly document it. The resolver must use explicit equality checks, not `??`, because null and undefined have different meanings.

Settings-source policy is orthogonal to model intent. Do not use a model alias to compensate for missing provider settings.

## Third-party provider configuration

Claude's supported mechanisms include:

- `ANTHROPIC_MODEL=<actual supported model/alias>`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `modelOverrides` for mapping Anthropic model IDs to provider-specific IDs
- `ANTHROPIC_CUSTOM_MODEL_OPTION` where appropriate

Reference: https://code.claude.com/docs/en/model-config#pin-models-for-third-party-deployments

Verify where these values are loaded in the Windows daemon runtime. Do not print their secret values.

## Acceptance criteria

- A fresh Claude session created from relay-web on this Windows instance can complete its first prompt through the third-party API without authorization failure.
- The observed model selection matches the user's configured provider mapping or explicit model intent.
- No Claude-specific literal `default` branch is added to relay-web.
- Existing explicit session models still override agent configuration.
- Existing agent-level model defaults still work when the intent is `inherit-agent`.
- Codex and other adapters are unchanged.
- A focused regression test fails before the fix and passes afterward; relevant broader tests and Windows CI pass.
- Debug instrumentation and captured secrets are removed/redacted before handoff.

## Deliverable

Report:

1. The exact root cause with evidence from the Windows instance.
2. Whether the failure was configuration, daemon environment, settings-source isolation, model-intent collapse, adapter inconsistency, or a combination.
3. The minimal fix and why it belongs at that module/seam.
4. Tests run and real-machine verification result.
5. Any upstream acpx or `claude-agent-acp` issue/PR that should be opened separately.

## Windows investigation result (2026-07-20)

### Confirmed runtime facts

- xacpx: `0.17.0-beta.9`; bundled acpx: `0.12.0`; Claude Code: `2.1.206`;
  managed `@agentclientprotocol/claude-agent-acp`: `0.59.0`.
- The configured xacpx `claude` agent has no `model` and no explicit `command`; its
  command resolves to the xacpx-managed adapter pin.
- The third-party endpoint, credential environment, and model mappings are present in
  `~/.claude/settings.json`. They are absent from the target workspace's project/local
  Claude settings and from the PowerShell/User/Machine environment inspected during the
  run. `ACPX_CLAUDE_INCLUDE_USER_SETTINGS` is also absent.
- The exact first-turn failure in the real relay session and in the focused smoke probe is
  `Authentication required`.
- `claude-agent-acp` initializes its `SettingsManager` with `resolveSettings({ cwd })`
  (all settings), but constructs the live Query with the restricted `settingSources`
  supplied by acpx. This explains why model choices derived from user settings can be
  advertised even though the live Query lacks the provider configuration.

### Deterministic red loop

```bash
xacpx doctor --smoke --agent claude --workspace node-bridge-oa --verbose
```

The unmodified Windows environment deterministically reports:

```text
FAIL Smoke: smoke transport probe failed
  detail: error: Authentication required
```

Injecting only the existing user-settings `ANTHROPIC_*` values into that one diagnostic
process removes the immediate authentication error, but the adapter then stalls beyond
three minutes during initialization/first prompt. The probe was terminated. Enabling all
user settings also stalls because this machine's user settings contain hooks/plugins, so
`ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` is not a safe final fix here.

### Local xacpx change

The smoke probe itself had a real seam mismatch: it did not copy
`agents.<name>.model` into its `ResolvedSession`, so it could test the adapter default while
normal relay/command sessions used the agent default. A focused unit test was added red,
then `src/doctor/checks/smoke-check.ts` was changed to resolve and report the configured
agent model exactly like the runtime session path.

No Claude-specific `default` branch was added to relay-web. Current `main` already omits a
blank/literal `default` model and has component coverage for that behavior. The saved
session's later `model: "default"` is not sufficient evidence of the create payload because
the transcript shows that the model was switched after creation; capture the RPC directly
before making a model-intent protocol change.

### Original workaround boundary

Before the xacpx fallback below, the safe operator workaround was to place only the required
provider `env`/model mapping in the target workspace's `.claude/settings.local.json`
(uncommitted), or in the environment that launches the daemon. Full user-settings opt-in
remains diagnostic/explicit-only.

An upstream `claude-agent-acp` issue should request that `SettingsManager` resolve and watch
the same `settingSources` used by the live Query. The installed Claude Agent SDK already
supports `resolveSettings({ cwd, settingSources })`. A separate acpx issue should cover the
adapter initialization stall observed when the provider environment is supplied without
user hooks/plugins.

### xacpx fallback implementation

xacpx now treats `agents.<name>.settingsPolicy` as a Claude-only settings boundary. The
implicit default is `provider-only`: when a third-party provider marker is found, xacpx
extracts only `ANTHROPIC_*` process values and exposes a sanitized user settings snapshot
containing only `model`, `modelOverrides`, and `availableModels`. Hooks, plugins, skills,
MCP servers, permissions, and other user settings remain excluded. Credentials are never
written into the snapshot or sent over the bridge protocol.

Operators can explicitly select `isolated` or `full-user`; the latter retains the original
full-user risk and is never selected automatically. Normal first-party setups remain on
the existing acpx behavior because `provider-only` is inert without a third-party provider
marker.

### Windows acceptance result

After building this fallback, the real command below completed successfully against the
same third-party configuration that previously returned `Authentication required`:

```powershell
node .\dist\cli.js doctor --smoke --agent claude --workspace node-bridge-oa --verbose
```

The smoke reply was exactly `ok`; doctor reported `PASS 11, WARN 0, FAIL 0, SKIP 0`.
The generated sanitized snapshot contained only the root `model` key on this machine and
contained no `env`, hooks, plugins, or permissions. No explicit `settingsPolicy` was added
to the user's config, so this verifies the implicit `provider-only` default.
