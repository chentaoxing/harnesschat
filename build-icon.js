// 打包 HarnessChat 图标资源
// 图标主视觉由 ComfyUI Qwen-Image 生成（assets/qwen-icon-1024b.png / qwen-icon-256b.png），
// 本脚本负责：256 → icon.ico（PNG-in-ICO）、1024 → icon.png、缩 32 → tray.png（内置极简 PNG 解码 + 均值缩放）。
// 重新设计图标时改 ComfyUI 工作流后重跑本脚本即可。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 极简 PNG 解码：支持 8-bit RGB/RGBA、非交错（本项目自产图足够）
function decodePNG(buf) {
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error('unsupported PNG: depth=' + bitDepth + ' color=' + colorType);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = Buffer.from(line);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 0: break;
        case 1: cur[i] = (cur[i] + a) & 0xff; break;
        case 2: cur[i] = (cur[i] + b) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
    }
    cur.copy(prev);
    for (let x = 0; x < w; x++) {
      const si = x * bpp, di = (y * w + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = bpp === 4 ? cur[si + 3] : 255;
    }
  }
  return { width: w, height: h, data: out };
}

// 均值缩放（缩小质量足够）
function resizeArea(img, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const sx = img.width / tw, sy = img.height / th;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx), x1 = Math.min(img.width, Math.ceil((tx + 1) * sx));
      const y0 = Math.floor(ty * sy), y1 = Math.min(img.height, Math.ceil((ty + 1) * sy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++;
      }
      const o = (ty * tw + tx) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: tw, height: th, data: out };
}

function encodePNG(img) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4);
    raw[row] = 0;
    data.copy(raw, row + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const assets = path.join(__dirname, 'assets');
fs.mkdirSync(assets, { recursive: true });

const src256 = fs.readFileSync(path.join(assets, 'qwen-icon-256b.png'));
const src1024 = fs.readFileSync(path.join(assets, 'qwen-icon-1024b.png'));

// icon.png（1024 主视觉）
fs.writeFileSync(path.join(assets, 'icon.png'), src1024);

// icon.ico：256px PNG 条目（Vista+ 支持 PNG 压缩条目）+ 32px 传统条目
const img256 = decodePNG(src256);
const png32 = encodePNG(resizeArea(img256, 32, 32));
fs.writeFileSync(path.join(assets, 'tray.png'), png32);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(2, 4); // 2 个条目
function icoEntry(png, size) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
  e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  return e;
}
const e256 = icoEntry(src256, 256), e32 = icoEntry(png32, 32);
const offset = 6 + 16 * 2;
e256.writeUInt32LE(offset, 12);
e32.writeUInt32LE(offset + src256.length, 12);
fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, e256, e32, src256, png32]));

console.log('icons written:', path.join(assets, '{icon.png,icon.ico,tray.png}'));
