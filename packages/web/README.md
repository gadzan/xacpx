# @ganglion/xacpx-web

Static dashboard for xacpx. The relay hub serves this build instead of copying it into its own package. A local web channel is planned to serve the same build.

The published package has no runtime dependencies. Vue and the other UI libraries are bundled into `dist/` at build time.

```js
import { resolveWebRoot, tryResolveWebRoot } from "@ganglion/xacpx-web";

const root = tryResolveWebRoot(); // absolute path to dist/, or undefined
```

Build from the repo root with `bun run build:web`.
