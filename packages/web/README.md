# @ganglion/xacpx-web

Static dashboard for xacpx. The relay hub and the local web channel both serve this build; neither copies it into its own package.

The published package has no runtime dependencies. Vue and the other UI libraries are bundled into `dist/` at build time.

```js
import { resolveWebRoot, tryResolveWebRoot } from "@ganglion/xacpx-web";

const root = tryResolveWebRoot(); // absolute path to dist/, or undefined
```

Build from the repo root with `bun run build:web`.
