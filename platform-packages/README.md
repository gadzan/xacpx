# Platform optional packages

OS-specific `@ganglion/xacpx-rmux-bridge-<os>-<arch>` packages live here, **outside**
the root `workspaces: ["packages/*"]` glob.

Putting them under `packages/` made `npm ci` on a Linux runner try to link
darwin/win32 packages and fail with `EBADPLATFORM`. These directories are
packed and published by `.github/workflows/publish-channel-relay.yml`; they are
not installed as workspace members.

Version pins stay in `packages/channel-relay/package.json` `optionalDependencies`.
Keep them in sync with `node ./scripts/sync-rmux-bridge-versions.mjs`.
