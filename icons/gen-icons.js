// 生成扩展图标（紫→靛渐变圆角底 + 白色气泡 + 镂空三点）
// 运行：node icons/gen-icons.js   （零依赖，Node 内置 zlib 手写 PNG 编码）
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const c = pixelFn(x, y);
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 图形（单位坐标 0..1，4x 超采样抗锯齿） ----------
const TOP = [0x8b, 0x5c, 0xfa]; // violet
const BOT = [0x4f, 0x46, 0xe5]; // indigo
const lerp = (a, b, t) => a + (b - a) * t;
const grad = (y) => {
  const t = Math.min(1, Math.max(0, y));
  return [Math.round(lerp(TOP[0], BOT[0], t)), Math.round(lerp(TOP[1], BOT[1], t)), Math.round(lerp(TOP[2], BOT[2], t))];
};

function inRoundRect(x, y, rx, ry, cx, cy, hw, hh) {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  if (dx > hw || dy > hh) return false;
  if (dx <= hw - rx || dy <= hh - ry) return true;
  const ex = dx - (hw - rx);
  const ey = dy - (hh - ry);
  return (ex * ex) / (rx * rx) + (ey * ey) / (ry * ry) <= 1;
}

function inTri(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function draw(size) {
  const S = 4;
  const N = S * S;
  const dotR = 0.033;
  const dotY = 0.385;
  const dotXs = [0.385, 0.5, 0.615];
  return (px, py) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let hit = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size;
        const y = (py + (sy + 0.5) / S) / size;
        if (!inRoundRect(x, y, 0.21, 0.21, 0.5, 0.5, 0.5, 0.5)) continue; // 圆角底板
        let c = grad(y);
        const bubble = inRoundRect(x, y, 0.09, 0.09, 0.5, 0.385, 0.3, 0.2);
        const tail = inTri(x, y, 0.345, 0.565, 0.455, 0.565, 0.29, 0.675);
        if (bubble || tail) c = [255, 255, 255];
        // 气泡内三点用底色，形成镂空效果
        if (bubble) {
          for (const dx of dotXs) {
            if ((x - dx) * (x - dx) + (y - dotY) * (y - dotY) <= dotR * dotR) {
              c = grad(dotY);
              break;
            }
          }
        }
        r += c[0];
        g += c[1];
        b += c[2];
        hit++;
      }
    }
    if (!hit) return [0, 0, 0, 0];
    return [Math.round(r / hit), Math.round(g / hit), Math.round(b / hit), Math.round((255 * hit) / N)];
  };
}

for (const size of [16, 32, 48, 128]) {
  const buf = png(size, draw(size));
  fs.writeFileSync(path.join(__dirname, 'icon' + size + '.png'), buf);
  console.log('icon' + size + '.png  ' + buf.length + ' bytes');
}
