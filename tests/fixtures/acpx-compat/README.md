# acpx compat fixtures

Real session records produced by the **published `acpx@0.13.0`** (npm, 2026-08-05) running against
the acpx repo's own `test/mock-agent.js` mock ACP agent, then sanitized:

- Machine-specific absolute paths (`/Users/<user>/...`, `/tmp/acpx-fixture-ws`) were replaced with
  neutral absolute paths (`/home/ci/...`, `/home/ci/projects/demo-app`).
- All other fields are byte-for-byte as written by acpx 0.13.0 (schema `acpx.session.v1`).

## Files

| File | What it models | Key difference |
|---|---|---|
| `session-legacy-no-argv.json` | acpx ≤0.12 / raw `--agent` session | has `agent_command`, **no** `agent_argv` |
| `session-current-with-argv.json` | acpx 0.13 session created from config `agents.<name>.argv` via positional alias | has `agent_command` **and** `agent_argv` |

## How the argv-capable record was produced

`~/.acpx/config.json` (temp HOME):

```json
{
  "agents": {
    "xacpx-managed-test": {
      "argv": ["node", "/home/ci/Projects/acpx/dist-test/test/mock-agent.js"]
    }
  }
}
```

Then `acpx xacpx-managed-test sessions new -s demo` and one prompt turn. acpx 0.13 resolves the
positional alias from config `argv` and persists:

- `agent_command` = `renderArgvIdentity(argv)` = `node /home/ci/Projects/acpx/dist-test/test/mock-agent.js`
  (identity-safe chars are unquoted; non-safe args are JSON-quoted, e.g. `"path with space"`),
- `agent_argv` = the exact array passed through.

The legacy record was produced with raw `--agent "node .../mock-agent.js"` (Unix path only; raw
`--agent` is rejected on Windows by acpx 0.13).

## Behavioral contract (verified against acpx 0.13.0)

- Session identity is `agent_command` (canonical argv identity), not the alias name.
- `sessions new/ensure` with a config `argv` agent creates records containing `agent_argv`.
- Index temp files are written as `index.json.<pid>.<timestamp>.<unique-id>.tmp` (UUID, may contain
  `-`); pre-0.13 naming was `index.json.<pid>.<timestamp>.tmp`.
- xacpx-managed overlays only merge `agents.<alias> = { argv }` into `~/.acpx/config.json`; they do
  not touch `.acpxrc.json` and never overwrite existing user agent entries.
