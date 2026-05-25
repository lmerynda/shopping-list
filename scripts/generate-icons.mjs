import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUTPUTS = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/icon-maskable-512.png", 512, true],
  ["public/icons/apple-touch-icon.png", 180, false],
];

const COLORS = {
  transparent: [0, 0, 0, 0],
  green: [44, 111, 65, 255],
  greenDark: [30, 79, 48, 255],
  cream: [250, 248, 240, 255],
  paper: [255, 255, 252, 255],
  paperShade: [226, 236, 226, 255],
  muted: [138, 157, 142, 255],
};

function createCanvas(size, fill = COLORS.transparent) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill[0];
    data[index + 1] = fill[1];
    data[index + 2] = fill[2];
    data[index + 3] = fill[3];
  }
  return { size, data };
}

function setPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const index = (Math.floor(y) * canvas.size + Math.floor(x)) * 4;
  canvas.data[index] = color[0];
  canvas.data[index + 1] = color[1];
  canvas.data[index + 2] = color[2];
  canvas.data[index + 3] = color[3];
}

function fillRoundedRect(canvas, x, y, width, height, radius, color) {
  const right = x + width;
  const bottom = y + height;
  for (let py = Math.floor(y); py < Math.ceil(bottom); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(right); px += 1) {
      const cx = px < x + radius ? x + radius : px > right - radius ? right - radius : px;
      const cy = py < y + radius ? y + radius : py > bottom - radius ? bottom - radius : py;
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(canvas, px, py, color);
      }
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        setPixel(canvas, x, y, color);
      }
    }
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeLine(canvas, ax, ay, bx, by, width, color) {
  const radius = width / 2;
  for (let y = Math.floor(Math.min(ay, by) - radius); y <= Math.ceil(Math.max(ay, by) + radius); y += 1) {
    for (let x = Math.floor(Math.min(ax, bx) - radius); x <= Math.ceil(Math.max(ax, bx) + radius); x += 1) {
      if (distanceToSegment(x, y, ax, ay, bx, by) <= radius) {
        setPixel(canvas, x, y, color);
      }
    }
  }
}

function drawIcon(size, maskable) {
  const scale = 4;
  const canvas = createCanvas(size * scale, maskable ? COLORS.green : COLORS.transparent);
  const s = canvas.size;

  fillRoundedRect(canvas, s * 0.06, s * 0.06, s * 0.88, s * 0.88, s * 0.22, COLORS.green);
  fillRoundedRect(canvas, s * 0.25, s * 0.18, s * 0.5, s * 0.64, s * 0.075, COLORS.paperShade);
  fillRoundedRect(canvas, s * 0.22, s * 0.15, s * 0.52, s * 0.64, s * 0.075, COLORS.paper);

  strokeLine(canvas, s * 0.34, s * 0.36, s * 0.43, s * 0.45, s * 0.045, COLORS.green);
  strokeLine(canvas, s * 0.43, s * 0.45, s * 0.61, s * 0.27, s * 0.045, COLORS.green);

  for (const y of [0.54, 0.65]) {
    fillCircle(canvas, s * 0.34, s * y, s * 0.025, COLORS.greenDark);
    strokeLine(canvas, s * 0.43, s * y, s * 0.64, s * y, s * 0.025, COLORS.muted);
  }

  return downsample(canvas, size, scale);
}

function downsample(source, size, scale) {
  const target = createCanvas(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const rgba = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * source.size + (x * scale + sx)) * 4;
          rgba[0] += source.data[index];
          rgba[1] += source.data[index + 1];
          rgba[2] += source.data[index + 2];
          rgba[3] += source.data[index + 3];
        }
      }
      const samples = scale * scale;
      setPixel(target, x, y, rgba.map((value) => Math.round(value / samples)));
    }
  }
  return target;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(canvas.size, 0);
  header.writeUInt32BE(canvas.size, 4);
  header[8] = 8;
  header[9] = 6;

  const rows = Buffer.alloc((canvas.size * 4 + 1) * canvas.size);
  for (let y = 0; y < canvas.size; y += 1) {
    const rowStart = y * (canvas.size * 4 + 1);
    rows[rowStart] = 0;
    Buffer.from(canvas.data.buffer, y * canvas.size * 4, canvas.size * 4).copy(rows, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [path, size, maskable] of OUTPUTS) {
  writeFileSync(path, encodePng(drawIcon(size, maskable)));
  console.log(`wrote ${path}`);
}
