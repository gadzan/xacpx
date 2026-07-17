# FAQ

## What if `/ss new` fails?

If session creation fails in WeChat, the most common cause is not a wrong `xacpx` command format, but that the underlying session was not created successfully.

You can try these two steps first:

1. Confirm in the terminal that the current project directory and the agent itself work
2. If you're familiar with `acpx`, manually create a session first, then attach to it from WeChat

For example, you can create a session locally first:

```bash
./node_modules/.bin/acpx --verbose --cwd /absolute/workspace/path codex sessions new --name existing-demo
```

Then attach to it from WeChat:

```text
/ss attach demo -a codex --ws backend --name existing-demo
```

## What is the `<id>` in `/mode <id>`?

The valid values for `/mode` depend on the agent you're currently using; `xacpx` does not normalize these values for you.

Currently the more clearly known values are:

- `codex`: `plan`
- `cursor`: `agent`, `plan`, `ask`

If you're unsure whether a value works, check the corresponding agent's docs first; if you get it wrong, you'll usually get an error such as an invalid argument.

## Why does an adapter download fail with npm E404?

`E404` usually means the selected registry does not contain or proxy the `@agentclientprotocol` adapter packages. New xacpx releases default managed adapter operations to the public npm registry, independently of the machine's generic or scope-specific company npm registry. Inspect the effective value with:

```bash
xacpx adapter registry
```

To use the public registry explicitly:

```bash
xacpx adapter registry set https://registry.npmjs.org/
xacpx restart
```

If company policy requires a private registry, ask its administrator to proxy or allowlist the `@agentclientprotocol` scope, then configure that registry with `xacpx adapter registry set <url>`. Put any registry-scoped token in `.npmrc`; xacpx rejects credentials embedded in the URL. `xacpx adapter check` is a quick way to verify that both managed packages are visible before creating another session.
