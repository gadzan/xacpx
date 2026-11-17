# Daemon Module

## Module goal

`src/daemon` turns the xacpx console into a **background process that can be started, queried, and stopped**.

It solves four problems:
- **Start the background process** — launch the console in detached mode.
- **Record running state** — write PID, status file, and log paths.
- **Provide observability** — let `xacpx status` know whether the daemon is actually alive.
- **Stop the process safely** — terminate the daemon per platform and clean up runtime files.

In one sentence: this is the **background process lifecycle management layer** — not a business message processing layer and not a CLI argument parsing layer.

## Runtime files

All runtime file paths are centralized in `daemon-files.ts` — nothing else computes these paths. Source: [`src/daemon/daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts)

| File | Content |
| --- | --- |
| `~/.xacpx/runtime/daemon.pid` | PID of the running daemon |
| `~/.xacpx/runtime/status.json` | Start time, heartbeat time, config path, state path, log paths |
| `~/.xacpx/runtime/stdout.log` | Daemon stdout |
| `~/.xacpx/runtime/stderr.log` | Daemon stderr |
| `~/.xacpx/runtime/app.log` | Structured application log (bounded / rolling) |
| `~/.xacpx/runtime/runtime-consumer.lock.json` | Stable metadata path for the OS-held, channel-independent core consumer lock |

### Module files

| File | Responsibility |
| --- | --- |
| [`daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts) | External control surface — `start()`, `getStatus()`, `stop()` |
| [`create-daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/create-daemon-controller.ts) | Controller factory — platform-specific spawn and terminate implementations |
| [`daemon-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-runtime.ts) | In-process registration — writes PID, status file, and heartbeat |
| [`daemon-files.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-files.ts) | Runtime file path definitions — the single source of truth for all paths |
| [`daemon-status.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-status.ts) | Status file persistence — read / write / clear `status.json`; defines `DaemonStatus` shape |
| [`runtime-consumer-lock.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/runtime-consumer-lock.ts) | OS-held core consumer lock (`flock` on POSIX / runtime-owner IPC guard on Windows) plus one compatibility fence per lock-capable channel |
| [`windows-daemon-runtime.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/windows-daemon-runtime.ts) | Windows daemon generation identity and orphan registry bookkeeping |
| [`posix-daemon-recovery.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/posix-daemon-recovery.ts) | POSIX status-only daemon identity recovery — consumer-lock and OS start-time proof |
| [`private-runtime-dir.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/private-runtime-dir.ts) | Private runtime directory invariant (`0700`) |

## Start lifecycle

`xacpx start` sequence:

1. `src/cli.ts` creates the daemon controller.
2. The controller reads the current PID and status, confirming the daemon is not already running.
3. The controller spawns a new background process in detached mode.
4. The new process enters `run-console.ts`.
5. `run-console.ts` calls `daemonRuntime.start()`, writing the PID and status files.
6. During the main loop, `daemonRuntime.heartbeat()` updates the timestamp periodically.
7. The controller polls `status.json` in the foreground until it sees the new process's PID reported as ready.
8. The CLI reports "started" to the user.

**Control vs. runtime split:** `daemon-controller.ts` manages external control; `daemon-runtime.ts` manages in-process self-registration. The two sides communicate only through the shared runtime files — there is no direct call from one to the other.

## Status lifecycle

`xacpx status` uses three signals to determine daemon liveness:

- **PID file** — tells us which process was last started.
- **Process existence** — tells us whether that PID is still running.
- **Status file** — tells us whether the daemon completed self-registration.

The resulting states:

| State | Condition |
| --- | --- |
| `running` | PID file exists, process exists, valid status file present |
| `stopped` | No evidence of a live daemon |
| `stopped` + `stale: true` | Old PID or status left by a dead process — the controller cleans up the remnants |
| `indeterminate` | A process is alive but its PID/status metadata is incomplete, inconsistent, or too stale to repair safely — blocks a second daemon start; status/doctor probes stay read-only while that PID is alive |

`DaemonController.getStatus()` does not just check files — it performs a **liveness check** on the actual process. This is its core value: a file's existence does not guarantee the process is alive. Source: [`src/daemon/daemon-controller.ts`](https://github.com/gadzan/xacpx/blob/main/src/daemon/daemon-controller.ts)

## Stop lifecycle

`xacpx stop` sequence:

1. Controller reads the PID file.
2. If the process is alive, terminates it using the platform-appropriate method.
3. Polls until the process has exited.
4. Cleans up the PID and status files.
5. Returns the stop result.

Platform-specific spawn and terminate behavior is encapsulated in `create-daemon-controller.ts`, keeping the control logic in `daemon-controller.ts` platform-agnostic.

## Testing notes

- The daemon module sits at the boundary of the process model, so most tests are integration-level: spawn a real subprocess, poll the status file, then stop it.
- Tests that write runtime files must use `mkdtemp` for isolation and clean up with `rm -rf`.
- Use `xacpx status` output rather than directly reading `status.json` to verify daemon state — that's the same path the user takes and exercises the full status logic.
- Do not use `Bun.sleep()` as a synchronization barrier when waiting for daemon readiness; poll `status.json` with a `until` loop or use the promise returned by the controller's polling logic.

### Extending the daemon module

Follow this order when adding new daemon capabilities:

1. Determine whether the new requirement is a **control-plane capability** (start/stop/liveness) or a **runtime capability** (what the daemon does while running).
2. Control-plane changes → `daemon-controller.ts`.
3. New in-process self-registration information → `daemon-runtime.ts` + `daemon-status.ts`.
4. New runtime files → `daemon-files.ts` first (centralize the path).
5. Platform differences → `create-daemon-controller.ts`.

If a change touches startup strategy, status file shape, stop strategy, and platform compatibility simultaneously, separate the control-plane changes from the runtime changes before writing code.

Code that belongs here:
- Daemon start / stop control logic.
- Runtime file path definitions.
- PID / status / heartbeat management.
- Cross-platform process termination and detached spawn.

Code that does not belong here:
- CLI argument parsing.
- WeChat message polling and processing.
- Agent or session business logic.
- Interpretation of config file contents.
