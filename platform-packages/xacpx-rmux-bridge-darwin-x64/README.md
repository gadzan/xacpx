# @ganglion/xacpx-rmux-bridge-<os>-<arch>

Optional platform package for the process-owned RMUX sidecar used by
`@ganglion/xacpx-channel-relay`.

Do not depend on this package directly from application code. Install
`@ganglion/xacpx-channel-relay` and let npm/bun select the matching optional
dependency for the current OS/CPU.

Self-contained: ships `bin/xacpx-rmux-bridge[.exe]`, `bin/rmux[.exe]`,
`bin/rmux-daemon[.exe]`, and `libexec/rmux/rmux[.exe]`. The bundled RMUX is
the pinned 0.10.0 official release (fixed URL + SHA-256) matching the bridge's
`rmux-sdk = "=0.10.0"` pin (no `../rmux` path dependency), so the terminal
works offline and machine-local RMUX on PATH can never shadow it. The bridge
uses the dedicated daemon binary rather than routing daemon startup through the
public CLI; on Windows this also keeps the daemon hidden instead of opening a
persistent console window. `checksums.json` records the SHA-256 of every
artifact; the package verifies and installs without network access.
