# `src/daemon` module notes

## Module goal

`src/daemon` is responsible for turning the xacpx console into a daemon that **can run in the background, can be queried for status, and can be stopped**.

It mainly solves four things:
- **Start the background process**: bring up the console in a detached manner.
- **Record runtime state**: write the PID, status file, and log paths.
- **Provide observability**: let `status` know whether the daemon is really alive.
- **Stop the process safely**: terminate the daemon per platform and clean up runtime files.

In one sentence: this is the **background-process lifecycle management layer**, not the business message-handling layer, nor the CLI argument-parsing layer.

## Its place in the overall architecture

The call chain is roughly:

`CLI start/status/stop -> daemon controller -> daemon runtime files/status -> run-console -> SDK/agent main loop`

The responsibility boundaries are:
- `src/cli.ts` is responsible for "**which command the user executed**".
- `src/daemon` is responsible for "**how the background process is started, how its liveness is judged, and how it is stopped**".
- `src/run-console.ts` is responsible for "**what actually runs inside the daemon process**".
- Other business modules are responsible for "**what specific capabilities are provided once the process is alive**".

On Windows, daemon startup also publishes a generation identity under `runtime/orphans/` and acquires a canonical named-pipe consumer guard. Managed preinstalled-adapter launches use one UUID token across argv, intent, owner, and residual records. Startup, the non-overlapping periodic sweep, shutdown, and `xacpx stop` all use the same fail-closed orphan registry and handle-stable process identity checks. Automatic cleanup never falls back to `taskkill`; the confirmed manual `xacpx orphans kill --confirm` command is the only broad operator escape hatch. Job Objects remain a deferred P3 improvement for descendants created after the final process snapshot.

## Directory structure

### `daemon-controller.ts`
The external control entry point.

Responsibilities:
- Provide `start()`, `getStatus()`, `stop()` to the outside.
- Read the PID file and the status file.
- Determine whether the process still exists.
- Handle stale runtime state and clean it up.
- Poll and wait for the daemon to enter the expected state during start and stop.

You can think of it as: the **control plane of the daemon**.

### `create-daemon-controller.ts`
The controller factory.

Responsibilities:
- Assemble the platform-specific dependencies of `DaemonController`.
- Provide the detached startup implementation.
- Provide the cross-platform termination implementation.
- Shield the startup/shutdown differences between Windows and non-Windows.

Its value is to separate the "**control logic**" from the "**platform details**".

### `daemon-runtime.ts`
The runtime registrar inside the daemon process.

Responsibilities:
- Write the PID file after the daemon actually starts.
- Write `status.json`, recording the start time, heartbeat time, config path, state path, and log path.
- Periodically update the heartbeat.
- Clean up the PID and status files on exit.

You can think of it as: the **self-registration plane of the daemon**.

### `daemon-files.ts`
The runtime file path definitions.

Responsibilities:
- Uniformly compute the runtime directory.
- Uniformly provide:
  - `daemon.pid`
  - `status.json`
  - `stdout.log`
  - `stderr.log`
  - `app.log`

It does no reading or writing; it is only responsible for **consolidating the path conventions**.

### `daemon-status.ts`
The status file storage.

Responsibilities:
- Read and write `status.json`.
- Clean up the status file.
- Define the structure of `DaemonStatus`.

It is a very thin persistence wrapper that prevents the status file format from being scattered elsewhere.

## Processing flow

Taking `xacpx start` as an example:

1. `src/cli.ts` creates the daemon controller.
2. The controller first checks the current PID / status to confirm it is not in a running state.
3. The controller brings up a new background process in a detached manner.
4. The new process enters `run-console.ts`.
5. `run-console.ts` calls `daemonRuntime.start()` to write the PID and status files.
6. While the daemon main loop is running, it periodically calls `daemonRuntime.heartbeat()` to update the timestamp.
7. The controller polls `status.json` in the foreground to confirm that the new process has reported ready.
8. The CLI then returns "started" to the user.

Taking `xacpx stop` as an example:

1. The controller reads the PID.
2. If the process is still alive, terminate it per platform.
3. Poll and wait for the process to exit.
4. Clean up the PID and status files.
5. Return the stop result.

On non-Windows platforms, an in-place upgrade can encounter a live legacy daemon
whose `status.json` heartbeat is still current but whose PID file is missing. When
queried, this remains read-only and indeterminate, so `start` cannot launch a
duplicate. An explicit `stop` or `restart` can adopt the status PID only when the
config/state paths, a daemon-mode consumer lock, a recent heartbeat, and the
OS-reported process start time all agree. PID reuse, stale evidence, or conflicting
metadata remains fail-closed. Immediately before terminating a recovered process,
the controller probes its OS start-time fingerprint again; a changed or unavailable
fingerprint preserves the evidence and refuses the PID-only kill.

New Windows daemons create their generation identity on the real published `cli.js run`
startup path and pass an inactive identity context to `buildApp`. The generation is
published only after the optional channel consumer guard is acquired and before any
startup reconciliation or orphan sweep. Ordinary foreground `xacpx run` processes do
not publish daemon generations, and a process that loses the consumer guard cannot
overwrite or sweep the active daemon's durable evidence. A daemon started before
durable generation identities were introduced
can be stopped after an in-place upgrade without falling back to an unverified PID
kill. The controller adopts that legacy daemon only when all independent evidence
agrees: PID/status metadata, a recent heartbeat, the handle-derived creation time
and executable, the current config root, and the exact `node cli.js run` command
line. The adopted creation identity is written durably before the existing
handle-fenced process-tree termination runs. Missing, stale, or conflicting
evidence remains fail-closed.

## Key state model

The daemon currently does not judge liveness by "looking at a single PID file"; it judges by combination:
- **PID file**: tells us "who was started before".
- **Whether the process exists**: tells us "whether this PID is still alive now".
- **Status file**: tells us "whether this daemon has completed self-registration".

After combining these three, the result falls roughly into four categories:
- **running**: the process exists and PID/status metadata agree.
- **stopped**: there is no evidence of a live daemon.
- **stale stopped**: there is an old PID/status, but the corresponding process no longer exists, and the controller cleans up the remnants.
- **indeterminate**: a process is alive but its PID/status metadata is incomplete,
  inconsistent, or too stale to repair safely. It blocks a second daemon start;
  ordinary status/doctor probes remain read-only while that PID is still alive.

This is also the core value of `daemon-controller.ts`: it not only looks at files, but also performs **liveness validation**.

## Relationship with `run-console.ts`

`src/daemon` is not responsible for the console's business main loop.

Its division of labor with `run-console.ts` is:
- `src/daemon` is responsible for "**whether this process is a manageable daemon**".
- `src/run-console.ts` is responsible for "**what business work this daemon process does after starting**".

So the daemon subsystem cares about:
- Whether the start succeeded
- Whether it is ready
- Whether the heartbeat has been updated
- Whether it has been stopped
- Whether the runtime files have been cleaned up

It does not care about WeChat message content, nor about command routing details.

## Design principles

This module follows several principles:

- **Separate the control plane from the runtime plane**: the controller manages external control, and the runtime manages in-process registration.
- **Centralize path conventions**: all runtime file paths are uniformly generated by `daemon-files.ts`.
- **Make state explicit**: expose the daemon's own metadata through `status.json`, rather than relying on implicit inference.
- **Prefer liveness checks over file checks**: a file existing does not mean the process is still alive; a process liveness check is required.
- **Consolidate cross-platform differences**: the platform-specific detached startup and termination logic is concentrated on the factory side.

## Code that belongs here

Code suitable for `src/daemon`:
- Daemon start/stop control logic.
- Runtime file path definitions.
- PID / status / heartbeat management.
- Cross-platform process termination or background bring-up logic.

Code not suitable here:
- CLI argument-parsing details.
- WeChat message polling and handling logic.
- Agent or session business logic.
- The business interpretation of the config file content itself.

The criterion is one sentence: if the code answers "**how this background process is managed**", it usually belongs here; if it answers "**what business runs inside this process**", it usually does not belong here.

## Modification advice

If you later want to extend the daemon's capabilities, it is recommended to make changes in the following order:

1. First clarify whether the addition is a **control-plane capability** or a **runtime-plane capability**.
2. If it is start/stop/liveness/cleanup related, prefer changing `daemon-controller.ts`.
3. If it is an extension of the daemon's own registration information, prefer changing `daemon-runtime.ts` and `daemon-status.ts`.
4. If it is a new log or a new runtime file, prefer changing `daemon-files.ts` to consolidate the path.
5. If it involves platform differences, then land it in `create-daemon-controller.ts`.

If a single requirement touches all of:
- The startup strategy
- The status file structure
- The stop strategy
- The platform compatibility logic

then you should first clearly separate the "control plane" from the "runtime plane" before changing code; do not pile all the changes into one file.
