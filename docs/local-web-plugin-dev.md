# Running Local Channel Plugins from Source

Channel plugins are npm packages. During development that is a problem: every
fix needs a beta publish and an upgrade before it can be loaded, so a typo costs
a full release round trip.

`scripts/dev-channel-web.mjs` points the plugin home at this checkout instead,
so the running daemon loads the builds under `packages/*`.

```bash
node ./scripts/dev-channel-web.mjs --build   # build, link, then restart
node ./dist/cli.js restart
```

After that, iterate with:

```bash
bun run build:channel-web
node ./dist/cli.js restart
```

Go back to the published packages with:

```bash
node ./scripts/dev-channel-web.mjs --unlink
node ./dist/cli.js restart
```

## What the script changes

It edits three places, and all three are restored by `--unlink`:

| Location | Change |
| --- | --- |
| `~/.xacpx/plugins/node_modules/@ganglion/xacpx-channel-web` | Junction to `packages/channel-web`; the npm copy is kept beside it as `.npm-backup` |
| `~/.xacpx/plugins/node_modules/@ganglion/xacpx-channel-relay` | Same, for `packages/channel-relay` (the local web channel imports its terminal entry) |
| `node_modules/xacpx/` in this checkout | A `plugin-api` resolution shim, written on every link |

`XACPX_PLUGIN_HOME` overrides the plugin home, which is useful when testing
against an isolated daemon.

## Why the shim is needed

Plugins are built with `--external xacpx` and import `xacpx/plugin-api` at
runtime. The daemon normally satisfies that import with a resolution shim inside
the plugin home. Pointing a plugin at this checkout makes Node resolve the import
from the checkout instead — so without a shim there, every plugin fails to load
with:

```
Cannot find package 'xacpx' imported from .../packages/channel-web/dist/index.js
```

The daemon then skips the plugin, and because the channel is still configured it
refuses to start:

```
Error: 频道 relay 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-relay
```

That error is misleading — the plugin is installed, and it is the missing shim
that broke the load. `scripts/dev-channel-web.mjs` writes the shim into both
trees so this cannot happen.

## Verifying it works

Check which build the daemon actually loaded, rather than trusting the link:

```bash
curl http://127.0.0.1:7138/api/instances
```

The local instance reports `conversations.timeline.v1` only when the running
code includes the timeline capability probe. A missing capability means the
dashboard shows "this daemon is too old" and hides every conversation, so it is
the fastest signal that a stale build is being served.

## Related

- [`docs/cli-reference.md`](./cli-reference.md) — the user-facing
  `xacpx channel add web` command and its flags.
- [`docs/developments.md`](./developments.md) — the three ways to run xacpx
  locally, of which this is the plugin-specific case.
- [`docs/release-automation.md`](./release-automation.md) — publishing the real
  package once the change is ready.
