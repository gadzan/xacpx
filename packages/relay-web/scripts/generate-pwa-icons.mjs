// Regenerate the committed PWA icons in public/ from the brand SVGs in assets/.
//
// Uses `bunx @vite-pwa/assets-generator` so the generator (and its native sharp
// dependency) is NOT a committed devDependency — CI builds never pull sharp.
// Run from the package root: `bun run generate-pwa-icons`.
//
//   assets/pwa-source.svg          -> pwa-64/192/512, apple-touch, favicon
//   assets/pwa-maskable-source.svg -> maskable-icon-512x512 (extra safe-zone padding)
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GEN = "bunx @vite-pwa/assets-generator@latest --preset minimal-2023";

function generate(svg, outDir) {
  // The generator writes alongside the source image, so render in a temp copy
  // to avoid clobbering assets/ and to pick exactly the outputs we want.
  const dir = mkdtempSync(join(tmpdir(), "pwa-icons-"));
  cpSync(svg, join(dir, "src.svg"));
  execSync(`${GEN} ${join(dir, "src.svg")}`, { stdio: "inherit" });
  return dir;
}

// Main icon set: full-bleed dark tile with the brand X.
const main = generate("assets/pwa-source.svg");
for (const f of [
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "apple-touch-icon-180x180.png",
  "favicon.ico",
]) {
  renameSync(join(main, f), join("public", f));
}
rmSync(main, { recursive: true, force: true });

// Maskable: same tile, mark pulled into the safe zone (purpose-built, not a copy).
const maskable = generate("assets/pwa-maskable-source.svg");
renameSync(join(maskable, "pwa-512x512.png"), "public/maskable-icon-512x512.png");
rmSync(maskable, { recursive: true, force: true });

console.log("pwa icons -> public/ (main + dedicated maskable)");
