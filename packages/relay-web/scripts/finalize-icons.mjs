// Finalize the generated PWA icons in public/ — fully cross-platform (node:zlib
// only, no Python, no macOS `sips`). Run by scripts/generate-pwa-icons.mjs after
// the rasterizer; safe to re-run (flatten is idempotent on opaque icons).
//
//   1. flatten pwa-64/192/512 onto the brand dark (#0E1116). @vite-pwa's
//      "transparent" icons carry a thin transparent edge margin; iOS composites
//      that onto white, leaving a white border on the Home Screen icon.
//      Compositing onto the opaque brand color makes a true full-bleed tile.
//   2. box-downscale the flattened pwa-512 to the 180x180 apple-touch icon
//      (opaque, no transparency for iOS to letterbox).
//
// Usage: node finalize-icons.mjs [publicDir]   (default: ./public)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";

const BG = [14, 17, 22]; // #0E1116
const dir = process.argv[2] ?? "public";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decode an 8-bit PNG (palette / RGBA / RGB / gray ± alpha) to flat RGBA bytes.
function decode(file) {
  const buf = readFileSync(file);
  let i = 8, ihdr, idat = [], plte = Buffer.alloc(0), trns = Buffer.alloc(0);
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IEND") break;
    i += 12 + len;
  }
  const W = ihdr.readUInt32BE(0), H = ihdr.readUInt32BE(4), ct = ihdr[9];
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * ch, px = Buffer.alloc(stride * H);
  let prev = Buffer.alloc(stride), p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
    }
    line.copy(px, y * stride);
    prev = line;
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let n = 0; n < W * H; n++) {
    const o = n * ch;
    let r, g, b, a;
    if (ct === 3) { const idx = px[o]; r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2]; a = idx < trns.length ? trns[idx] : 255; }
    else if (ct === 6) { r = px[o]; g = px[o + 1]; b = px[o + 2]; a = px[o + 3]; }
    else if (ct === 2) { r = px[o]; g = px[o + 1]; b = px[o + 2]; a = 255; }
    else if (ct === 4) { r = g = b = px[o]; a = px[o + 1]; }
    else { r = g = b = px[o]; a = 255; }
    rgba.set([r, g, b, a], n * 4);
  }
  return { W, H, rgba };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
function encodeRgb(file, W, H, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(rgb.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (W * 3 + 1) + 1);
  }
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}

function compositeRgb({ W, H, rgba }) {
  const rgb = new Uint8Array(W * H * 3);
  for (let n = 0; n < W * H; n++) {
    const a = rgba[n * 4 + 3];
    for (let k = 0; k < 3; k++) rgb[n * 3 + k] = Math.floor((rgba[n * 4 + k] * a + BG[k] * (255 - a)) / 255);
  }
  return rgb;
}

// Box-filter downscale: average each destination pixel over its source region.
function downscaleRgb(srcW, srcH, rgb, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 3);
  const sx = srcW / dstW, sy = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy), y1 = Math.max(y0 + 1, Math.min(srcH, Math.floor((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx), x1 = Math.max(x0 + 1, Math.min(srcW, Math.floor((dx + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * srcW + x) * 3; r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; n++;
      }
      const o = (dy * dstW + dx) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// 1. Flatten the full-bleed PNGs onto the brand dark.
for (const f of ["pwa-64x64.png", "pwa-192x192.png", "pwa-512x512.png"]) {
  const p = join(dir, f);
  const img = decode(p);
  encodeRgb(p, img.W, img.H, compositeRgb(img));
  console.log(`flattened ${p} (${img.W}x${img.H})`);
}

// 2. apple-touch: opaque 180x180 box-downscaled from the flattened pwa-512.
const big = decode(join(dir, "pwa-512x512.png"));
const small = downscaleRgb(big.W, big.H, compositeRgb(big), 180, 180);
encodeRgb(join(dir, "apple-touch-icon-180x180.png"), 180, 180, small);
console.log(`apple-touch-icon-180x180.png <- pwa-512 (box-downscaled)`);
