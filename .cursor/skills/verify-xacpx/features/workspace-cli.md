# Workspace CLI

A user registers project directories on the machine with `xacpx workspace`, then later references them from chat as `--ws <name>`.

## Sub-features

- `ws-list-seed` lists the seeded `home` workspace after first config write.
- `ws-add` registers the current directory under an explicit name.
- `ws-list-after-add` shows the new name and path.
- `ws-rm` removes the added workspace and leaves `home` in place.

## How to get to it (user POV)

- Run `xacpx workspace list` (alias `xacpx ws list`).
- Run `xacpx workspace add <name>` from the directory to register.
- Run `xacpx workspace rm <name>`.

## Driving it with control-xacpx

Preconditions:

- Isolated verify `HOME` is seeded.
- Seeded list includes `- home:`.
- No workspace named `verify-lab` exists.

- **Seeded list.** Run `control-xacpx cli -- workspace list`. Exit code `0`. Stdout contains `Workspaces:` and `- home:`.
- **Add.** From a disposable directory whose path you will record, run `control-xacpx cli -- workspace add verify-lab`. Exit code `0`. Stdout is `Workspace "verify-lab" saved: <absolute-cwd>`.
- **List after add.** Run `control-xacpx cli -- workspace list`. Stdout contains both `- home:` and `- verify-lab: <absolute-cwd>`.
- **Config persistence.** Read `$HOME/.xacpx/config.json`. `workspaces.verify-lab.cwd` equals that same absolute path.
- **Remove.** Run `control-xacpx cli -- workspace rm verify-lab`. Exit code `0`. Stdout is `Workspace "verify-lab" removed`.
- **List after remove.** Run `control-xacpx cli -- workspace list`. `verify-lab` is absent; `home` remains.
- **Proof.** Save list-after-add stdout and the `workspaces` object from `config.json` to `$VERIFY_EVIDENCE/workspace-cli/`. They both name `verify-lab` and the recorded cwd. After cleanup of `verify-lab`, keep those files.

## Gotchas

- `workspace add` without a name uses the current directory's basename. Use an explicit `verify-lab` so the assertion does not depend on `/tmp` folder names.
- Seeded `home` points at `~` expanded inside this isolated `HOME`. Do not delete `home` during this recipe; restoring it is a different path.
- Names with spaces or special characters are sanitized unless `--raw`. Do not use those names in this recipe.
- Chat `/ws new` is a different entry point (`/workspace` in WeChat). This file covers the terminal CLI only.
