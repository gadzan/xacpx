// Regenerate the committed PWA icons in public/ from assets/pwa-source.svg.
//
// Uses `bunx @vite-pwa/assets-generator` so the generator (and its native sharp
// dependency) is NOT a committed devDependency — CI builds never pull sharp.
// Run from the package root: `bun run generate-pwa-icons`.
//
// The generator emits the "transparent" icons with a thin transparent edge
// margin, which iOS composites onto white (a white border around the Home
// Screen icon). flatten-icons.py composites every pixel onto the brand dark so
// the tile is a true full-bleed square. apple-touch is then downscaled from the
// flattened pwa-512 (opaque, no transparency for iOS to letterbox).
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

// Flatten the transparent edge margin onto #0E1116 so every icon is a hard,
// opaque, full-bleed square (no white border on iOS / desktop).
execSync("python3 scripts/flatten-icons.py public/pwa-64x64.png public/pwa-192x192.png public/pwa-512x512.png", { stdio: "inherit" });

// apple-touch: opaque full-bleed, downscaled from the now-opaque pwa-512.
execSync("sips -z 180 180 public/pwa-512x512.png --out public/apple-touch-icon-180x180.png", { stdio: "inherit" });

console.log("pwa icons -> public/");
