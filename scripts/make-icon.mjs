// Generate the app icon (assets/icon.png) from the DeepSeek whale mark in
// assets/icon.svg (sourced from deepseek-harness website/public/favicon.svg).
// Rasterized with sharp at 512x512 — crisp for taskbar, tray, and packaging.
// Run: npm run make-icon
//
// Note: sharp is provided by the DSH runtime dependency tree (dsh-attachment),
// so it is present in node_modules after `npm install`.

import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE = 512;
const src = join(__dirname, "..", "assets", "icon.svg");
const out = join(__dirname, "..", "assets", "icon.png");

const svg = readFileSync(src, "utf8");
// The SVG is authored at 50x50; bump the intrinsic size so sharp rasterizes at
// full resolution instead of upscaling a tiny 50px render.
const sized = svg.replace(/width="\d+" height="\d+"/, `width="${SIZE}" height="${SIZE}"`);
const png = await sharp(Buffer.from(sized)).png().toBuffer();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log("icon written:", out, png.length, "bytes");
