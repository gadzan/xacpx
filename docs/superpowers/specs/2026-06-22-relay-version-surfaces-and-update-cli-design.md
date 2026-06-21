# Relay version surfaces + `xacpx-relay update` — Design

Date: 2026-06-22
Status: Approved (pending spec review)

## Goal

Three related changes that make the relay hub's and connectors' versions visible, and
let operators self-update the hub from its CLI:

1. **Settings page** shows the running relay (hub) version, plus an "update available"
   hint when a newer `@ganglion/xacpx-relay` is published.
2. **Manage-instance dialog** shows the instance's reported version (the connector's
   xacpx core version) as a read-only row.
3. **`xacpx-relay update`** CLI command self-updates the hub package, with a
   `--check` dry-run.

## Context (current state)

- The connector already reports its xacpx **core version**: `RelayClient.sendHandshake`
  sends `coreVersion` in both `instance.register` and `instance.auth`
  (`packages/channel-relay/src/relay-client.ts`), sourced from
  `ChannelStartInput.coreVersion`.
- The hub stores it: `instances.core_version` column (`packages/relay/src/db.ts`),
  written on register / `touch` (`packages/relay/src/stores/instances.ts`,
  `gateway/instance-gateway.ts`).
- `GET /api/instances` returns `coreVersion` per instance
  (`packages/relay/src/http/app.ts`); the web store already carries it on
  `InstanceView.coreVersion` (`packages/relay-web/src/stores/instances.ts`) and shows it
  **only as a tooltip** in `InstanceTree.vue`. i18n keys `instance.coreVersion` /
  `instance.coreVersionUnknown` already exist (en + zh-CN).
- The hub does **not** read its own version at runtime and exposes **no** version
  endpoint. `GET /api/config` returns history-retention/limits only.
- Core has a full `src/cli-update.ts` (plugins, weacpx→xacpx rename migration,
  interactive multi-target selection). The relay CLI (`packages/relay/src/cli.ts`)
  dispatches `start` / `add token` / `ls` / `rm token` via simple `args[0]` checks.

## Feature 2 — Instance version in the Manage dialog (web-only)

The data is already in the store, so this is a presentation change only.

- `packages/relay-web/src/components/ManageInstanceDialog.vue`: add a read-only section
  after the Name section, before `WorkspacesManager`:
  - Label: new i18n key `instance.versionLabel` ("Instance version" / "实例版本").
  - Value: `instance.coreVersion` when present, else `$t("instance.coreVersionUnknown")`
    (reuse the existing unknown string).
- No protocol, hub, or store changes.

**Test:** existing dialog/instance test renders the version row for a known version and
the "unknown" fallback for a null `coreVersion`.

## Feature 1 — Relay version in Settings (+ update-available)

### Hub

- New `packages/relay/src/version.ts`:
  - `readRelayVersion(): string` — reads relay's own `package.json` `version`,
    resolving against `import.meta.url` (same approach as `resolveBundledWebRoot`),
    falling back to `"unknown"`.
  - `getLatestNpmVersion(pkg: string): Promise<string | null>` — `npm view <pkg> version
    --json`, parsed leniently; returns `null` on any failure. Mirrors core's helper.
  - `compareSemver` / `isNewer` helper (port core's numeric major.minor.patch compare;
    a prerelease ranks below the same release).
- New endpoint **`GET /api/version`** in `packages/relay/src/http/app.ts`, auth-gated
  like the rest, returning:
  ```json
  { "current": "0.6.0", "latest": "0.6.1", "updateAvailable": true }
  ```
  - The `latest` lookup is **cached with a ~1h TTL** and **timeout-guarded** (a few
    seconds). On error/timeout/offline it returns `{ current, latest: null,
    updateAvailable: false }` so a Settings load never blocks on npm.
  - Cache is a small in-module/holder value `{ value, fetchedAt }`; injectable clock +
    fetcher for tests. `updateAvailable = latest != null && isNewer(latest, current)`.
- Rationale for a dedicated endpoint (not extending `/api/config`): `/api/config` is a
  fast local read consumed on mount; folding a possibly-slow npm lookup into it would
  couple unrelated concerns and risk slowing config.

### Web

- `packages/relay-web/src/views/SettingsView.vue`: new "Relay" section (placed near the
  bottom, before Account). On mount fetch `GET /api/version`:
  - Always show `Relay v{current}`.
  - When `updateAvailable`, show a muted hint:
    `Update available: v{latest} — run \`xacpx-relay update\``.
  - On fetch failure, show just the dash/unknown — never block the page.
- New i18n keys (en + zh-CN): `settings.relayTitle`, `settings.relayVersion`,
  `settings.relayUpdateAvailable` (templated with `{latest}`).

**Tests:** version util (read, cache hit/miss via injected clock, error→null);
`/api/version` (current-only when fetcher fails, updateAvailable true/false); settings
render (version line; update hint shown only when `updateAvailable`).

## Feature 3 — `xacpx-relay update` CLI

New `packages/relay/src/cli-update.ts` — a trimmed single-target version of core's
(no plugins, no rename successor, no interactive selection):

- `handleRelayUpdate(args: string[], deps): Promise<number>`
  - `--check`: print current + latest (or "latest unknown"); exit 0. No install.
  - default: 
    - latest unknown → print error, exit 1.
    - latest == current → "already up to date (vX)", exit 0.
    - latest newer → run `updateSelf()`, print "updated to vX", exit 0.
- `deps` (injectable for tests): `readCurrentVersion`, `getLatestVersion`, `updateSelf`,
  `print`. Defaults:
  - `getLatestVersion` → `getLatestNpmVersion("@ganglion/xacpx-relay")` from `version.ts`.
  - `updateSelf` → `npm install -g @ganglion/xacpx-relay@latest`, or `bun add -g …` when
    `PACKAGE_MANAGER=bun`. Reuse core's win32 `shell:true` spawn pattern (npm `.cmd`).
- Wire into `packages/relay/src/cli.ts`: `if (args[0] === "update") return
  handleRelayUpdate(args.slice(1), …)`, and add an `update [--check]` line to `USAGE`.

**Tests:** `--check` prints both versions without installing; update path calls
`updateSelf` when newer; up-to-date path skips install; latest-unknown exits 1;
bun-vs-npm command selection via injected/env.

## Shared

`version.ts` (`readRelayVersion`, `getLatestNpmVersion`, `isNewer`) serves both
`/api/version` and the `update` CLI — one source of truth for version logic in the relay
package.

## Out of scope (YAGNI)

- No update-available indicator for instance versions (only the hub's own).
- No auto-update; no web button that triggers the update (CLI only).
- No new protocol messages — instance version reuses the existing `coreVersion` field.

## Release note

Test/feature changes land under `packages/relay` (hub + web bundle) and
`packages/relay-web`; ship as the next `@ganglion/xacpx-relay` minor (e.g. `0.7.0`).
No core / relay-protocol / channel-relay changes, so those packages are untouched.
