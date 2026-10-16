# Doctor

`xacpx doctor` prints a read-only diagnostic report for the isolated install: config, runtime paths, daemon, WeChat login, acpx, and related checks.

## Sub-features

- `doctor-config` loads the seeded `config.json`.
- `doctor-summary` prints a `Summary: PASS … WARN … FAIL … SKIP …` tally.
- `doctor-no-fail` stays at exit `0` when nothing is `FAIL` (WARN/SKIP allowed).
- `doctor-verbose` adds `detail:` lines including the config path.

## How to get to it (user POV)

- Run `xacpx doctor`.
- Run `xacpx doctor --verbose`.

## Driving it with control-xacpx

Preconditions:

- Isolated verify `HOME` is seeded.
- No daemon was started in this home.
- Do not pass `--smoke` or `--fix`.

- **Default report.** Run `control-xacpx doctor`. Capture stdout, stderr, and exit code.
- **Config.** Stdout contains `PASS Config: configuration loaded`.
- **Expected idle warnings.** Stdout contains `WARN Daemon:` with `daemon is not running` and `WARN WeChat: wechat is not logged in`.
- **Smoke skipped.** Stdout contains `SKIP Smoke:` (smoke is opt-in).
- **Summary.** Stdout contains a line matching `Summary: PASS <n>, WARN <n>, FAIL 0, SKIP <n>`. Exit code is `0`.
- **Verbose path.** Run `control-xacpx doctor --verbose`. Stdout contains `detail: config path: $HOME/.xacpx/config.json`.
- **Proof.** Save default stdout to `$VERIFY_EVIDENCE/cli-doctor/doctor.txt`. The file shows PASS Config, FAIL 0, and the isolated `$HOME/.xacpx` path in verbose output saved next to it.

## Gotchas

- Doctor against a missing config is `FAIL Config` and exit `1`. Seed with `workspace list` first.
- `--smoke` is not this feature. It starts a real acpx session.
- `--fix` mutates local files. Do not use it to make a red report look green.
- `WARN` does not fail the process. Assert `FAIL 0`, not “all PASS”.
- Isolated tmp homes often also `WARN Runtime: daemon runtime dir should be private (mode 0700)`. That is still idle-install, not a drive failure.
- WeChat WARN is required for an isolated home. `PASS WeChat` means this run is not isolated or reused a logged-in store.
