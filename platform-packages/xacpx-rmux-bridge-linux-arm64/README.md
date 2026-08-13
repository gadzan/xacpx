# @ganglion/xacpx-rmux-bridge-linux-arm64

Optional platform package for the process-owned RMUX sidecar used by
`@ganglion/xacpx-channel-relay`.

Do not depend on this package directly from application code. Install
`@ganglion/xacpx-channel-relay` and let npm/bun select the matching optional
dependency for the current OS/CPU.

Built from `packages/channel-relay/native/rmux-bridge` against crates.io
`rmux-sdk = "=0.10.0"` (no `../rmux` path dependency).
