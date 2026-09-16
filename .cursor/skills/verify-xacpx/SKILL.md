---
name: verify-xacpx
description: Drive xacpx the way a user does — isolated CLI and chat-command dry-run (no WeChat login). Use when proving terminal commands, `/help` `/status` `/workspace` chat paths, or doctor against a disposable HOME. Do not use for live WeChat, daemon start on the operator's real ~/.xacpx, or Relay Web dashboard (those are separate surfaces).
---

# Verify xacpx

xacpx is a chat console that remote-controls `acpx` sessions. The path an agent can drive without IM credentials is the **terminal CLI** plus **chat-command dry-run** (the same router WeChat would hit, with no channel login).

Other surfaces exist and are out of scope for this skill unless a feature file says otherwise:

- Live WeChat / Feishu / Yuanbao / Discord login
- Background daemon (`xacpx start` / `run`) on the operator's real home
- Relay Hub + Relay Web dashboard (`packages/relay-web`; Playwright e2e already lives there)
- `tests/smoke/` (needs a real acpx session and a real WeChat login)

## Launch

Use a disposable home. Never point `HOME` at the operator's real account.

```bash
export RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
export VERIFY_REPO_ROOT="$(git rev-parse --show-toplevel)"
export VERIFY_HOME="${TMPDIR:-/tmp}/xacpx-verify-$RUN_ID"
export VERIFY_EVIDENCE="$VERIFY_REPO_ROOT/.cursor/skills/verify-xacpx/artifacts/$RUN_ID"
export HOME="$VERIFY_HOME"
unset XACPX_CONFIG XACPX_STATE WEACPX_CONFIG WEACPX_STATE
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
mkdir -p "$VERIFY_HOME" "$VERIFY_EVIDENCE"
```

Seed config (creates `$HOME/.xacpx/config.json` from `config.example.json`; includes the default `home` workspace):

```bash
"$VERIFY_REPO_ROOT/.cursor/skills/verify-xacpx/bin/control-xacpx" cli -- workspace list
```

Ready when that command exits `0`, stdout contains `Workspaces:`, and `$HOME/.xacpx/config.json` exists.

This surface is short-lived CLI / dry-run. There is no server to keep alive. Do not `xacpx start` unless a feature file explicitly requires a daemon **in this same `VERIFY_HOME`**.

## Doctor

Read-only. Run before driving, and whenever a command looks off:

```bash
"$VERIFY_REPO_ROOT/.cursor/skills/verify-xacpx/bin/control-xacpx" doctor
"$VERIFY_REPO_ROOT/.cursor/skills/verify-xacpx/bin/control-xacpx" env
```

Worth driving when all of these hold:

- `control-xacpx` did not refuse the home (isolated `xacpx-verify-*` directory)
- `env` prints the same `HOME` / `config` as this run
- `xacpx version` matches `"version"` in `$VERIFY_REPO_ROOT/package.json`
- doctor includes `PASS Config: configuration loaded` and a `Summary:` line
- doctor `FAIL` count is `0` (WARN is expected: daemon not running, WeChat not logged in; SKIP is expected for Smoke without `--smoke`)

Not worth driving when:

- `HOME` is the operator's real home or doctor Config is `FAIL`
- a daemon pid file exists under this `VERIFY_HOME` that this run did not start
- you need `/session new` or a real prompt and doctor `acpx` / `Bridge` is `FAIL`

Do not pass `--fix` or `--smoke` unless the feature file asks. `--smoke` starts a real acpx session.

## Drive

Harness: `control-xacpx` (repo-local; see Helpers). It refuses a non-isolated `HOME`.

```bash
control-xacpx cli -- <xacpx-args...>
control-xacpx dry-run -- --chat-key wx:verify -- "/help" "/status"
control-xacpx doctor
control-xacpx env
```

Stable handles (assert these strings; `LANG=en_US.UTF-8` is required):

| Surface | Handle |
| --- | --- |
| CLI help | stdout line `xacpx version - Show version` |
| CLI version | exact `package.json` version, exit `0` |
| CLI workspace list (seeded) | `Workspaces:` and a `- home:` line |
| CLI workspace add | `Workspace "<name>" saved: <cwd>` |
| CLI workspace empty (only after removing every workspace) | `No workspaces yet.` |
| Chat `/help` | `Quick access:` and `- /status - view current session status` |
| Chat `/status` with no session | `No session is currently selected. Run /session new ... or /use <alias> first.` |

Prefer these over timestamps, log paths, or doctor WARN text.

Read `.cursor/skills/verify-xacpx/features/README.md` and drive the matching feature file. A proof that uses one convenient entry is incomplete when that file lists others.

## Evidence

Write under `$VERIFY_EVIDENCE` (default `.cursor/skills/verify-xacpx/artifacts/<run-id>/`). Cleanup must not delete this directory.

Proof standards:

- Exercise the real CLI / dry-run user path. Do not call `SessionService` or write `state.json` by hand to fake a session.
- Capture the command, stdout, stderr, and exit code for every step, plus a follow-up read (list after add, `/status` after `/help`).
- For workspace mutations, also read `$HOME/.xacpx/config.json` and confirm `workspaces.<name>.cwd`.
- Dry-run still loads config and may write `$HOME/.xacpx/`. That is expected. It must not talk to WeChat. Confirm by doctor WeChat remaining `wechat is not logged in` and by no new files under a real `~/.xacpx` outside `VERIFY_HOME`.
- `bun run dry-run` is not a network sandbox. Do not treat the name as proof that acpx was never spawned. `/help` and `/status` do not create sessions; `/session new` does and is a different feature.

## Cleanup

Tear down only what this run created:

1. If this run started a daemon, stop it with `control-xacpx cli -- stop` using the same `HOME`. Wait until `control-xacpx cli -- status` prints `xacpx is not running`. Do not `pkill`.
2. `rm -rf "$VERIFY_HOME"` (the disposable home, including `.xacpx`).
3. Leave `$VERIFY_EVIDENCE` in place.

If a drive fails, still run cleanup so the next run is not blocked by a leftover home or daemon.

## Helpers

`bin/control-xacpx` is executable. From a launched verify environment:

```bash
CONTROL="$VERIFY_REPO_ROOT/.cursor/skills/verify-xacpx/bin/control-xacpx"
"$CONTROL" env
"$CONTROL" cli -- version
"$CONTROL" cli -- --help
"$CONTROL" doctor
"$CONTROL" dry-run -- --chat-key wx:verify -- "/help" "/status"
```

It runs `bun "$VERIFY_REPO_ROOT/src/cli.ts"` and `bun "$VERIFY_REPO_ROOT/src/dry-run.ts"` so a `dist/` rebuild is not required. It exits `2` if `HOME` is not an `xacpx-verify-*` directory (`VERIFY_ALLOW_SHARED_HOME=1` overrides; do not use that on a real account).
