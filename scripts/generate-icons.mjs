// Generates the PWA PNG icons under public/ with zero image dependencies.
// Draws a full-bleed navy tile with a centered teal/white 2×2 "SoHo" mark, so
// the icon works as both an `any` and a `maskable` icon (content stays inside
// the maskable safe zone). Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NAVY = [18, 49, 77]; // #12314d
const TEAL = [13, 122, 111]; // #0d7a6f
const LIGHT = [231, 238, 242]; // #e7eef2

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  // pixels: Uint8Array of RGBA, length size*size*4
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy
      ? pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(pixels.buffer, y * stride, stride).copy(
          raw,
          y * (stride + 1) + 1,
        );
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  // Full-bleed navy background.
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) set(x, y, NAVY);

  // Centered 2×2 grid of rounded squares inside the safe zone (~46% of tile).
  const grid = Math.round(size * 0.46);
  const gap = Math.round(size * 0.03);
  const cell = Math.round((grid - gap) / 2);
  const originX = Math.round((size - grid) / 2);
  const originY = Math.round((size - grid) / 2);
  const radius = Math.round(cell * 0.22);

  const tiles = [
    [0, 0, TEAL],
    [1, 0, LIGHT],
    [0, 1, LIGHT],
    [1, 1, TEAL],
  ];

  const inRounded = (lx, ly, w, h, rad) => {
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
    const nearL = lx < rad,
      nearR = lx >= w - rad;
    const nearT = ly < rad,
      nearB = ly >= h - rad;
    if ((nearL || nearR) && (nearT || nearB)) {
      const cx = nearL ? rad : w - 1 - rad;
      const cy = nearT ? rad : h - 1 - rad;
      const dx = lx - cx,
        dy = ly - cy;
      return dx * dx + dy * dy <= rad * rad;
    }
    return true;
  };

  for (const [gx, gy, color] of tiles) {
    const ox = originX + gx * (cell + gap);
    const oy = originY + gy * (cell + gap);
    for (let ly = 0; ly < cell; ly++)
      for (let lx = 0; lx < cell; lx++)
        if (inRounded(lx, ly, cell, cell, radius)) set(ox + lx, oy + ly, color);
  }

  return px;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public");
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  writeFileSync(join(outDir, `icon-${size}.png`), png);
  console.log(`wrote public/icon-${size}.png (${png.length} bytes)`);
}
