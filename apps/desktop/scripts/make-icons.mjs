#!/usr/bin/env node
/**
 * 아이콘 생성기 — 외부 이미지 편집기 없이 리포지토리 안에서 재현 가능하게 만든다.
 *
 * 출력: src-tauri/icons/{32x32,128x128,128x128@2x,icon}.png, src-tauri/icons/icon.ico
 * 의존성 없음(순수 zlib). 디자인은 단순 기하 도형만 쓴다 — 사진·폰트·유료 자산 없음.
 *
 * 사용: node scripts/make-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

const BG = [11, 18, 32]; // #0B1220
const RING = [94, 234, 212]; // #5EEAD4
const DOT = [226, 232, 240]; // #E2E8F0

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 픽셀 버퍼를 PNG로 인코딩한다(8bit, 컬러타입 6). */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 기하 도형 (슈퍼샘플 2x2 안티에일리어싱) ---

function insideRoundedRect(x, y, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(x - cx) - (halfW - r);
  const dy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r <= 0;
}

const PLATE = { half: 262, radius: 74 };
const RINGGEOM = { outerHalf: 176, outerRadius: 52, thickness: 30, gap: 14 };
const DOTS = [
  [232, 336],
  [320, 336],
  [408, 336],
];

function ringGap(px, py) {
  const outer = insideRoundedRect(px, py, 320, 320, RINGGEOM.outerHalf, RINGGEOM.outerHalf, RINGGEOM.outerRadius);
  const innerHalf = RINGGEOM.outerHalf - RINGGEOM.thickness;
  const inner = insideRoundedRect(px, py, 320, 320, innerHalf, innerHalf, RINGGEOM.outerRadius - RINGGEOM.thickness);
  return outer && !inner;
}

function dotGap(px, py) {
  return DOTS.some(([cx, cy]) => Math.hypot(px - cx, py - cy) <= RINGGEOM.gap + 12);
}

function render(size) {
  const SS = 2;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
          const px = (u + 1) * 320;
          const py = (v + 1) * 320;
          const plate = insideRoundedRect(px, py, 320, 320, PLATE.half, PLATE.half, PLATE.radius);
          if (!plate) {
            continue;
          }
          let color = BG;
          if (dotGap(px, py)) color = DOT;
          else if (ringGap(px, py)) color = RING;
          rSum += color[0];
          gSum += color[1];
          bSum += color[2];
          aSum += 1;
        }
      }
      const n = SS * SS;
      const alpha = Math.round((aSum / n) * 255);
      const i = (y * size + x) * 4;
      const c = aSum > 0 ? aSum : 1;
      rgba[i] = Math.round(rSum / c);
      rgba[i + 1] = Math.round(gSum / c);
      rgba[i + 2] = Math.round(bSum / c);
      rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, rgba);
}

/** 256x256 PNG 한 장을 담은 ICO (Vista+ PNG-compressed 엔트리). */
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256 -> 0
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png]);
}

mkdirSync(OUT_DIR, { recursive: true });

const png256 = render(256);
const files = [
  ["32x32.png", render(32)],
  ["128x128.png", render(128)],
  ["128x128@2x.png", png256],
  ["icon.png", render(512)],
  ["icon.ico", encodeIco(png256)],
];

for (const [name, data] of files) {
  writeFileSync(join(OUT_DIR, name), data);
  process.stdout.write(`${name}: ${data.length} bytes\n`);
}
