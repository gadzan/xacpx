# CLI version and help

The terminal CLI prints this xacpx release version and the command list without starting a daemon or touching WeChat.

## Sub-features

- `cli-version` prints the same version as `package.json`.
- `cli-help` prints the English usage list including doctor, version, and workspace.

## How to get to it (user POV)

- Run `xacpx version` (aliases `--version` and `-v`).
- Run `xacpx --help` (alias `-h`).

## Driving it with control-xacpx

Preconditions:

- Isolated verify `HOME` is seeded.
- `LANG=en_US.UTF-8`.
- `control-xacpx env` shows `config_exists=yes`.

- **Version.** Ask the CLI for its version. Run `control-xacpx cli -- version`. Exit code `0`. Stdout is exactly the `version` field from `$VERIFY_REPO_ROOT/package.json` (currently `0.24.5` if that file is unchanged).
- **Version aliases.** Run `control-xacpx cli -- --version` and `control-xacpx cli -- -v`. Both match the same version string and exit `0`.
- **Help.** Run `control-xacpx cli -- --help`. Exit code `0`. Stdout starts with `Usage:` and includes the lines `xacpx doctor - Run diagnostics`, `xacpx version - Show version`, and `xacpx workspace list|add [name] [--raw]|rm <name> - Manage local workspaces (alias: ws)`.
- **Proof.** Save stdout from version and help to `$VERIFY_EVIDENCE/cli-version-help/version.txt` and `$VERIFY_EVIDENCE/cli-version-help/help.txt`. Both files identify xacpx; help.txt contains `xacpx version - Show version`.

## Gotchas

- Without `LANG=en_US.UTF-8`, help text may be Chinese (`xacpx version - 查看版本`). Assert the English strings only when LANG is English.
- `xacpx` with no arguments is not this feature; it may print help and exit `1`.
- Version `unknown` means the CLI could not find `@ganglion/xacpx` in a nearby `package.json`. Drive from the repo via `control-xacpx`, not a random global install.
