// Generate the app icon (256x256 PNG) without binary tooling:
// hand-rolled PNG chunks + node:zlib, 2x supersampled for anti-aliasing.
// Design: rounded-square indigo gradient + white chat bubble with three
// brand-slate dots. Run: npm run make-icon

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const SS = 2; // supersampling factor

const top = [22, 33, 62];      // dark indigo
const bottom = [74, 108, 247]; // bright blue
const bubble = [255, 255, 255];
const dot = [45, 58, 97];      // slate-indigo (brand-primary)

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function inRoundRect(x, y, cx, cy, w, h, r) {
  const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
  return Math.hypot(dx, dy) <= r;
}

function inTail(x, y) {
  // triangle: (74,158)-(96,196)-(120,158)
  const ax = 74, ay = 158, bx = 96, by = 196, cx = 120, cy = 158;
  const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

function sample(x, y) {
  const r = 52;
  const dx = Math.max(0, r - x, x - (SIZE - 1 - r));
  const dy = Math.max(0, r - y, y - (SIZE - 1 - r));
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  const t = (x + y) / (2 * (SIZE - 1));
  let c = lerp(top, bottom, t);
  if (inRoundRect(x, y, 128, 126, 150, 92, 30) || inTail(x, y)) c = bubble;
  const dots = [[92, 126], [128, 126], [164, 126]];
  for (const [dx2, dy2] of dots) {
    if (Math.hypot(x - dx2, y - dy2) <= 11) c = dot;
  }
  return [c[0], c[1], c[2], 255];
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
    }
    const n = SS * SS;
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a === 0) { raw[i + 3] = 0; }
    else { raw[i] = Math.round(r / a); raw[i + 1] = Math.round(g / a); raw[i + 2] = Math.round(b / a); raw[i + 3] = Math.round(a / n); }
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log("icon written:", out, png.length, "bytes");

