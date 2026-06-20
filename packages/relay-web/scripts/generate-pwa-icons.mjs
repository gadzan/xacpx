// Regenerate the committed PWA icons in public/ from assets/pwa-source.svg.
//
// Uses `bunx @vite-pwa/assets-generator` so the generator (and its native sharp
// dependency) is NOT a committed devDependency — CI builds never pull sharp.
// Run from the package root: `bun run generate-pwa-icons`.
//
// One full-bleed source serves every icon: the X sits inside the maskable safe
// zone, so the same PNGs are declared "any maskable" in src/pwa-options.ts.
import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The generator writes alongside the source image, so render in a temp copy to
// avoid clobbering assets/ and to pick exactly the outputs we want.
const dir = mkdtempSync(join(tmpdir(), "pwa-icons-"));
cpSync("assets/pwa-source.svg", join(dir, "src.svg"));
execSync(`bunx @vite-pwa/assets-generator@latest --preset minimal-2023 ${join(dir, "src.svg")}`, { stdio: "inherit" });

for (const f of [
  "pwa-64x64.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "apple-touch-icon-180x180.png",
  "favicon.ico",
]) {
  renameSync(join(dir, f), join("public", f));
}
rmSync(dir, { recursive: true, force: true });

console.log("pwa icons -> public/");
