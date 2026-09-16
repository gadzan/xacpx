# xacpx verification map

This directory is the maintained source for verifying user-facing xacpx CLI and chat-command behavior. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Isolated `HOME` at `$VERIFY_HOME` (`/tmp/xacpx-verify-$RUN_ID`). Never the operator's real home.
- `LANG=en_US.UTF-8` and `LC_ALL=en_US.UTF-8`.
- `XACPX_CONFIG` / `XACPX_STATE` (and `WEACPX_*` aliases) unset.
- Seed completed: `control-xacpx cli -- workspace list` exited `0` and `$HOME/.xacpx/config.json` exists.
- `control-xacpx doctor` reports `PASS Config` and `FAIL` count `0`.
- `control-xacpx` is on the invocation path shown in the skill Helpers section.
- Never drive an instance whose `HOME` this run did not create.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted chat commands and flags unchanged.
- Run terminal actions through `control-xacpx cli --`.
- Run chat actions through `control-xacpx dry-run -- --chat-key wx:verify --`.
- Restore seeded workspaces after a mutation. Do not remove proof artifacts during cleanup.
- Do not `xacpx login`, `xacpx start`, or `/session new` unless the feature file says so.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the last command.
- CLI proof includes the command, stdout, stderr, and exit code.
- Mutation proof includes a second read (`workspace list` or `config.json`).
- Chat proof includes the dry-run `> <input>` line and the following reply text.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-xacpx` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [CLI version and help](./cli-version-help.md) covers `xacpx version` and `xacpx --help`.
- [Doctor](./cli-doctor.md) covers the read-only diagnostic report against an isolated home.
- [Chat help and status](./chat-help-status.md) covers `/help` and `/status` through dry-run with no session.
- [Workspace CLI](./workspace-cli.md) covers `workspace list|add|rm` persistence in `config.json`.
