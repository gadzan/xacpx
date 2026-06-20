// Regenerate the committed PWA icons in public/ from assets/pwa-source.svg.
//
// Uses `bunx @vite-pwa/assets-generator` so the generator (and its native sharp
// dependency) is NOT a committed devDependency — CI builds never pull sharp.
// Run from the package root: `bun run generate-pwa-icons`. Fully cross-platform:
// the only external step is the bunx rasterizer; finalize-icons.mjs (node:zlib)
// flattens the icons and produces the apple-touch — no Python, no macOS `sips`.
//
// The generator emits the "transparent" icons with a thin transparent edge
// margin, which iOS composites onto white (a white border around the Home
// Screen icon); finalize-icons.mjs composites every pixel onto the brand dark so
// the tile is a true full-bleed square, then box-downscales pwa-512 to the
// 180x180 apple-touch (opaque, no transparency for iOS to letterbox).
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The generator writes alongside the source image, so render in a temp copy to
// avoid clobbering assets/ and to pick exactly the outputs we want.
const dir = mkdtempSync(join(tmpdir(), "pwa-icons-"));
cpSync("assets/pwa-source.svg", join(dir, "src.svg"));
execSync(`bunx @vite-pwa/assets-generator@latest --preset minimal-2023 ${join(dir, "src.svg")}`, { stdio: "inherit" });

// Keep the full-bleed PNGs + favicon; discard the preset's padded apple-touch.
for (const f of ["pwa-64x64.png", "pwa-192x192.png", "pwa-512x512.png", "favicon.ico"]) {
  renameSync(join(dir, f), join("public", f));
}
rmSync(dir, { recursive: true, force: true });

// Flatten onto #0E1116 (hard, opaque, full-bleed tiles) + build the apple-touch.
execSync("node scripts/finalize-icons.mjs public", { stdio: "inherit" });

console.log("pwa icons -> public/");
