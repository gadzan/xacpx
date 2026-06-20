// Flatten PWA icon PNGs onto the brand dark (#0E1116), in place.
//
// @vite-pwa/assets-generator emits the "transparent" icons with a thin
// transparent margin/antialiased edge. iOS composites that onto white, leaving
// a white border around the Home Screen icon. Compositing every pixel onto the
// opaque brand color makes the tile a true full-bleed square (dark to every
// edge and corner) while preserving the gradient X.
//
// Usage: node flatten-icons.mjs <file.png> [<file.png> ...]
// Pure Node stdlib (node:zlib) so the icon-regen step needs no Python / extra deps.
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const BG = [14, 17, 22]; // #0E1116

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(buf) {
  let i = 8;
  let ihdr;
  let idat = [];
  let plte = Buffer.alloc(0);
  let trns = Buffer.alloc(0);
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
  return { ihdr, idat: Buffer.concat(idat), plte, trns };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodeToRgba(file) {
  const buf = readFileSync(file);
  const { ihdr, idat, plte, trns } = readChunks(buf);
  const W = ihdr.readUInt32BE(0);
  const H = ihdr.readUInt32BE(4);
  const ct = ihdr[9];
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(idat);
  const stride = W * ch;
  const out = Buffer.alloc(stride * H);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) line[x] = (line[x] + paeth(a, b, c)) & 255;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    let r, g, b, a;
    const o = i * ch;
    if (ct === 3) {
      const idx = out[o];
      r = plte[idx * 3];
      g = plte[idx * 3 + 1];
      b = plte[idx * 3 + 2];
      a = idx < trns.length ? trns[idx] : 255;
    } else if (ct === 6) {
      [r, g, b, a] = [out[o], out[o + 1], out[o + 2], out[o + 3]];
    } else if (ct === 2) {
      [r, g, b, a] = [out[o], out[o + 1], out[o + 2], 255];
    } else if (ct === 4) {
      r = g = b = out[o];
      a = out[o + 1];
    } else {
      r = g = b = out[o];
      a = 255;
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { W, H, rgba };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgb(file, W, H, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (W * 3 + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(file, png);
}

function flatten(file) {
  const { W, H, rgba } = decodeToRgba(file);
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const a = rgba[i * 4 + 3];
    for (let k = 0; k < 3; k++) {
      rgb[i * 3 + k] = Math.floor((rgba[i * 4 + k] * a + BG[k] * (255 - a)) / 255);
    }
  }
  encodeRgb(file, W, H, rgb);
  console.log(`flattened ${file} (${W}x${H}) -> opaque RGB on #0E1116`);
}

for (const f of process.argv.slice(2)) flatten(f);
