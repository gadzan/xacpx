# Verification stack

`scripts/verify-stack.mjs` boots a throwaway daemon + relay hub + bundled dashboard so a
feature can be verified on the real surface (real Web UI, real RPC, real daemon) instead of
through a proxy. It is developer tooling. It is not part of `npm test` and never runs in CI.

## Commands

```bash
node ./scripts/verify-stack.mjs up [--port 18787] [--router-ready]
node ./scripts/verify-stack.mjs status
node ./scripts/verify-stack.mjs down
node ./scripts/verify-stack.mjs doctor
```

| Flag | Effect |
| --- | --- |
| `--port <n>` | Hub HTTP port. Default `18787`. |
| `--router-ready` | Writes a restricted router command and enables it, so the daemon starts with `conversations.router` availability `ready`. Without it the stack starts `disabled-by-config`, which is the honest-failure path. |

`up` prints the dashboard URL and an access token. Sign in at `/login` with that token.
Everything lives under `<tmp>/xacpx-verify-stack`, including a `manifest.json` that records the
PIDs, the port and an mtime snapshot of the real `~/.xacpx`.

## What `up` builds

- `config.json` / `state.json` for the daemon, pointing the relay channel at the local hub.
- A plugin home holding the **workspace** builds of `@ganglion/xacpx-channel-relay` and
  `@ganglion/xacpx-relay-protocol` plus their runtime closure (`proper-lockfile`, `ws`,
  `graceful-fs`, `retry`, `signal-exit`). Published packages lag the repo, so a connector built
  from `node_modules` alone cannot speak an unreleased RPC.
- A hub SQLite database with one access token.
- The hub process and the daemon process, both detached from the invoking shell, so they
  survive the command that started them.

## Isolation rules

Each of these exists because skipping it broke a real run.

| Variable | Why |
| --- | --- |
| `HOME` | The relay connector keeps its credential in `<home>/.xacpx/relay/credential.json`. Without redirection the daemon pairs against the operator's real hub and the handshake fails with `auth-failed`. |
| `XACPX_PLUGIN_HOME` | Keeps the operator's installed plugins from being read or rewritten. |
| `WEACPX_CONFIG` / `WEACPX_STATE` | Keeps every daemon write inside the state dir. |
| `--port 18787` | A port nobody else uses. `up` refuses to start when a foreign process holds it. |

## Teardown guarantees

`down` is ordered and exception-safe. A failure in one step never skips the rest.

1. `xacpx stop` through the isolated env, which reads the pid file inside the state dir.
2. Kill the hub and daemon PIDs recorded in the manifest. Each one is re-identified by command
   line first, so a recycled PID is never signalled.
3. Sweep every process whose command line still references the state dir, and kill those too.
   This is also the recovery path when the manifest is gone.
4. Verify the port is free and no process references the state dir.
5. Diff the real `~/.xacpx` against the snapshot taken at `up`. Any change is reported as a
   problem, not silently accepted.
6. Remove the state dir entry by entry, manifest last, so one locked file cannot strand the
   rest and a failed teardown still leaves a manifest for the next `down` to read.

`doctor` is the stateless check for leftovers: a manifest with live PIDs, a busy default port,
a process referencing the state dir, or a stray scheduled task. `status` reports what is
currently running and where the logs are.

## Failure modes already handled

| Symptom | Cause | Handled by |
| --- | --- | --- |
| `auth-failed` right after connect | `HOME` not redirected, daemon reused the real relay credential | `daemonEnv` |
| `Cannot find module 'graceful-fs'` mid-run | Plugin home missing a transitive dependency | `planPluginHome` resolves the closure and fails `up` with names |
| Port already in use | Another stack, or a foreign process | `up` refuses unless it started the process |
| `EPERM` while removing the state dir | A live hub still holds `relay.db` | Kill before remove, remove entry by entry |
| A previous run crashed and left a hub | Manifest lost by a partial remove | Manifest-less `down` recovery by path |

## Adding a case

The script owns the stack, not the scenario. Drive the scenario from a browser, a CLI call, or
a throwaway script against the printed URL, then run `down` and `doctor`. Keep scenario
assertions out of this file: `tests/unit/scripts/verify-stack.test.ts` covers only the pure
planning and teardown helpers.
