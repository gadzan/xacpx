# `xacpx doctor`

`xacpx doctor` runs a series of read-only diagnostics against your local
xacpx installation (config, runtime paths, daemon, channels, transport,
plugins, and the orchestration IPC surface) and prints a report. With
`--fix` it can additionally apply a small set of safe, local repairs.

## Running it

```bash
xacpx doctor                       # run all default checks
xacpx doctor --verbose             # include extra diagnostic detail
xacpx doctor --smoke               # also run the opt-in smoke probe
xacpx doctor --agent codex         # pin the agent used by the smoke probe
xacpx doctor --workspace backend   # pin the workspace used by the smoke probe
xacpx doctor --fix                 # apply safe local repairs, then re-check
```

### Exit code

- `0` — no check reports `fail` (after any `--fix` repairs and re-checks).
- `1` — at least one check still reports `fail`.

Unknown flags (or `--agent`/`--workspace` without a value) print the CLI
help and exit with `1`.

## Checks

Checks run and render in this fixed order. Each check has a stable `id`
(used internally to re-run a check after a repair) and a human-readable
label shown in the report:

| Order | id                      | Label             | What it verifies |
|-------|-------------------------|-------------------|------------------|
| 1     | `config`                | Config            | `config.json` loads and validates. |
| 2     | `runtime`               | Runtime           | The daemon runtime dir and its pid/status/log files are usable (writable or creatable). On POSIX it also checks the runtime dir is private (mode `0700`). |
| 3     | `logs`                  | Logs              | Sums the sizes of the daemon log files (`app.log`/`stdout.log`/`stderr.log` plus rotation siblings) and `warn`s on growth (a single file over 50 MB, or all combined over 200 MB); `skip` when the runtime dir has no logs yet. Unreadable individual files are tolerated (skipped), not failed. |
| 4     | `daemon`                | Daemon            | Daemon liveness via the daemon controller (running / stopped / indeterminate). Also scans for stale consumer-lock files when stopped. |
| 5     | `orphans`               | Windows orphans   | On Windows, inspects durable orphan intent/owner/residual evidence read-only; uncertainty is retained and reported rather than deleted. `skip`s on other platforms. |
| 6     | `wechat`                | WeChat            | The WeChat (Weixin) channel is logged in. |
| 7     | `acpx`                  | acpx              | The resolved `acpx` binary reports a usable version. |
| 8     | `bridge`                | Bridge            | The acpx bridge subprocess starts and responds. |
| 9     | `plugins`               | Plugins           | Configured plugins are installed, loadable, and enabled. |
| 10    | `orchestration`         | Orchestration     | Orchestration state in `state.json` is healthy (inspected read-only; never quarantined as a side effect). Heartbeat freshness is checked against `orchestration.progressHeartbeatSeconds`. |
| 11    | `orchestration-socket`  | Orchestration IPC | `skip`s when the daemon is stopped; only when the daemon is live (running or indeterminate) does it probe whether the orchestration IPC endpoint actually accepts connections (`fail` only on a definitive no-listener, `pass`/`skip` on reachable or ambiguous). |
| 12    | `smoke`                 | Smoke             | End-to-end probe of a real session. **Opt-in:** skipped unless `--smoke` is passed. |

## Severities

Every check reports one of four severities:

- **pass** — healthy.
- **warn** — degraded but still working (for example: daemon not running,
  WeChat logged out, runtime dir mode not `0700`, invalid state records
  that the daemon would quarantine at next startup).
- **fail** — broken; a failing check drives a non-zero exit code.
- **skip** — not applicable or not requested (for example: Smoke without
  `--smoke`, or a check that cannot run because the Config check failed).

A summary line tallies the counts, e.g.
`Summary: PASS 5, WARN 3, FAIL 1, SKIP 2`.

Windows orphan warnings do not trigger automatic broad process termination. Review the evidence first; `xacpx orphans kill --confirm` is the explicit manual cleanup path.

## Flags

- `--verbose` — include extra diagnostic detail in checks that support it
  (WeChat, acpx, Bridge).
- `--smoke` — run the opt-in Smoke check (a real end-to-end session probe).
- `--agent <name>` — pin the agent the Smoke probe uses.
- `--workspace <name>` — pin the workspace the Smoke probe uses.
- `--fix` — apply safe local repairs, then re-run the affected checks.

## `--fix`: the repair model and safety

By default, doctor is strictly read-only. Under `--fix`, doctor walks the
checks and runs the repairs each one attached. Repairs are deliberately
conservative:

- A repair runs only if it is **safe and local**. State-mutating repairs
  are **gated** (see below) and are withheld while a daemon is running.
- A withheld repair is reported as `skipped` with the reason instead of
  running.
- If a repair throws or returns failure, it is recorded as `failed`;
  a bad repair can never crash doctor.
- Only checks that had at least one repair successfully applied are
  re-run, so the report reflects the post-repair state.

After repairs, doctor prints a `Repairs:` section, one line per repair:

```
Repairs:
- create/repair runtime dir with mode 0700: applied (runtime dir ... created/repaired with mode 0700)
- quarantine invalid state.json records: skipped (stop the daemon first: xacpx stop)
```

When `--fix` is **not** passed, a check that has a repair available is
flagged inline, e.g.:

```
WARN Runtime: daemon runtime dir should be private (mode 0700) (fixable — run: xacpx doctor --fix)
```

### What auto-applies (safe / local)

- `runtime.ensure-private-dir` — create or repair the runtime dir with
  mode `0700`. **Ungated** (it only adjusts the private runtime dir's own
  permissions), so it applies even while the daemon runs.
- `state.quarantine` — quarantine invalid/corrupt records in `state.json`
  (drop bad records, back the original up as `state.json.quarantine-*`, or
  rename an unreadable file to `state.json.corrupt-*`). **Gated** on the
  daemon being stopped.
- `daemon.clear-stale-lock` — remove stale `*-consumer.lock.json` files
  whose recorded pid is definitively not running. Offered **only when the
  daemon is stopped** (a running or indeterminate daemon owns the lock).

### What stays a suggestion only (never auto-applied)

These conditions are surfaced as suggestions, never as runnable repairs:

- **Missing or broken plugin** — installing a plugin needs network access.
- **Disabled plugin** — re-enabling is an explicit operator decision.
- **Invalid config** — config edits must be made deliberately by you.
- **WeChat logged out** — re-login is interactive (`xacpx login`).

### Daemon-stopped gating

State-mutating repairs (`state.quarantine`, `daemon.clear-stale-lock`)
must never race a live daemon, which owns `state.json` and the consumer
locks. While the daemon is running, those repairs are **withheld** and
reported as `skipped` with a "stop the daemon first: `xacpx stop`" reason.
Stop the daemon, re-run `xacpx doctor --fix`, then start it again.

Daemon liveness is detected independently of any check output: the
`indeterminate` state (a live daemon pid whose `status.json` is missing)
is treated as a live daemon, so lock removal is not offered there either.
A process that exists but cannot be signalled (`EPERM`) also counts as
alive. If daemon state cannot be determined at all, doctor fails safe and
treats the daemon as running, withholding the state-mutating repairs.

The gate is also re-verified at apply time: if a daemon starts between
the read-only detection pass and `--fix` applying a repair,
`state.quarantine` refuses to run (reported as `failed` with a "stop it
first" message) and `daemon.clear-stale-lock` re-checks each lock and
leaves any lock alone whose owner is alive again.
