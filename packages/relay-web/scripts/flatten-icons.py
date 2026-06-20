#!/usr/bin/env python3
"""Flatten PWA icon PNGs onto the brand dark (#0E1116), in place.

@vite-pwa/assets-generator emits the "transparent" icons with a thin
transparent margin/antialiased edge. iOS composites that onto white, leaving a
white border around the Home Screen icon. Compositing every pixel onto the
opaque brand color makes the tile a true full-bleed square (dark to every edge
and corner) while preserving the gradient X.

Usage: python3 flatten-icons.py <file.png> [<file.png> ...]
Pure stdlib (zlib + struct) so the icon-regen step needs no extra deps.
"""
import struct, sys, zlib

BG = (14, 17, 22)  # #0E1116


def load(path):
    d = open(path, "rb").read()
    i, idat, plte, trns = 8, b"", b"", b""
    W = H = ct = None
    while i < len(d):
        ln = struct.unpack(">I", d[i:i + 4])[0]
        t = d[i + 4:i + 8]
        data = d[i + 8:i + 8 + ln]
        i += 12 + ln
        if t == b"IHDR":
            W, H, _bd, ct = struct.unpack(">IIBB", data[:10])
        elif t == b"IDAT":
            idat += data
        elif t == b"PLTE":
            plte = data
        elif t == b"tRNS":
            trns = data
        elif t == b"IEND":
            break
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    raw = zlib.decompress(idat)
    stride, out, prev, p = W * ch, bytearray(), bytes(W * ch), 0

    def paeth(a, b, c):
        q = a + b - c
        pa, pb, pc = abs(q - a), abs(q - b), abs(q - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    for _y in range(H):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - ch] if x >= ch else 0
            b = prev[x]
            c = prev[x - ch] if x >= ch else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 255
        out += line
        prev = line
    return W, H, ch, ct, bytes(out), plte, trns


def rgba(W, H, ch, ct, buf, plte, trns):
    for i in range(W * H):
        v = buf[i * ch:i * ch + ch]
        if ct == 3:
            idx = v[0]
            r, g, b = plte[idx * 3:idx * 3 + 3]
            a = trns[idx] if idx < len(trns) else 255
        elif ct == 6:
            r, g, b, a = v
        elif ct == 2:
            r, g, b = v; a = 255
        elif ct == 4:
            r = g = b = v[0]; a = v[1]
        else:
            r = g = b = v[0]; a = 255
        yield r, g, b, a


def write_rgb(path, W, H, rgb):
    def ck(t, data):
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        raw += rgb[y * W * 3:(y + 1) * W * 3]
    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n" + ck(b"IHDR", ihdr) + ck(b"IDAT", zlib.compress(bytes(raw), 9)) + ck(b"IEND", b"")
    )


def flatten(path):
    W, H, ch, ct, buf, plte, trns = load(path)
    out = bytearray()
    for r, g, b, a in rgba(W, H, ch, ct, buf, plte, trns):
        out.append((r * a + BG[0] * (255 - a)) // 255)
        out.append((g * a + BG[1] * (255 - a)) // 255)
        out.append((b * a + BG[2] * (255 - a)) // 255)
    write_rgb(path, W, H, bytes(out))
    print(f"flattened {path} ({W}x{H}) -> opaque RGB on #0E1116")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        flatten(p)
