// Owner: Person 3 (for Person 4's sign-up page). A contact card (vCard) so people can save their Restock
// number as "restock" in one tap, with the logo as the photo. iOS and Android don't let a website add a
// contact silently; tapping the link shows a filled-in card, then "Create New Contact" saves it.
import { deflateSync } from "node:zlib";
import { config } from "../config.js";

/** The name the contact is saved under (the brand is written in lowercase). */
export const CONTACT_NAME = "restock";

// ---------------------------------------------------------------------------------------------------------
// The logo, drawn as a PNG. Same shapes and colors as the <symbol id="logo"> in public/landing.html
// (a receipt stub with an "r" and an arrow), on the brand yellow, padded so a round contact photo crop
// doesn't cut the corners. Drawn in code so we don't need an image library.
// ---------------------------------------------------------------------------------------------------------

type Pt = [number, number];
const INK: [number, number, number] = [0x16, 0x16, 0x16];
const YELLOW: [number, number, number] = [0xff, 0xe8, 0x66];

function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 10): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps = 20): Pt[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  });
}

// The stub: rounded top corners, zigzag bottom edge (viewBox 0 0 40 40).
const STUB: Pt[] = [
  ...arc(9, 6, 3, Math.PI, 1.5 * Math.PI),
  ...arc(31, 6, 3, 1.5 * Math.PI, 2 * Math.PI),
  [34, 33], [30.5, 36.5], [27, 33], [23.5, 36.5], [20, 33], [16.5, 36.5], [13, 33], [9.5, 36.5], [6, 33],
];
// The "r" and the arrow: polylines with stroke widths, drawn with round caps and joins.
const STROKES: { pts: Pt[]; width: number }[] = [
  { pts: [[15, 13.5], [15, 28]], width: 4.5 },
  { pts: [...cubic([15, 20], [15, 15.5], [18, 13], [22.5, 13]), [24, 13]], width: 4.5 },
  { pts: [[21.8, 8.8], [26, 13], [21.8, 17.2]], width: 4 },
];

function insidePolygon([x, y]: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearPolyline([x, y]: Pt, pts: Pt[], radius: number): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const ex = ax + t * dx - x, ey = ay + t * dy - y;
    if (ex * ex + ey * ey <= radius * radius) return true;
  }
  return false;
}

/** The color at a point in logo units (0..40). */
function colorAt(p: Pt): [number, number, number] {
  if (p[0] < 6 || p[0] > 34 || p[1] < 3 || p[1] > 36.5) return YELLOW; // outside the stub: background
  if (STROKES.some((s) => nearPolyline(p, s.pts, s.width / 2))) return YELLOW; // the mark sits on the stub
  if (insidePolygon(p, STUB)) return INK;
  return YELLOW; // background
}

/** Draw the logo as RGB pixels, `samples`×`samples` per pixel for smooth edges. */
function drawLogo(size: number, samples = 4): Buffer {
  const scale = (size * 0.44) / 22; // the farthest stub corner is 22 units from the center
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = 20 + (px + (sx + 0.5) / samples - size / 2) / scale;
          const y = 19.75 + (py + (sy + 0.5) / samples - size / 2) / scale;
          const c = colorAt([x, y]);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = samples * samples, o = (py * size + px) * 3;
      rgb[o] = Math.round(r / n); rgb[o + 1] = Math.round(g / n); rgb[o + 2] = Math.round(b / n);
    }
  }
  return rgb;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG of RGB pixels (8-bit, no filtering). */
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter method, no interlace
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let cachedPhoto: Buffer | undefined;
/** The contact photo (256×256 PNG), drawn once and reused. */
export function contactPhoto(): Buffer {
  return (cachedPhoto ??= encodePng(drawLogo(256), 256, 256));
}

// ---------------------------------------------------------------------------------------------------------
// The vCard.
// ---------------------------------------------------------------------------------------------------------

/** vCard lines are at most 75 characters; longer ones continue on lines that start with a space. */
function fold(line: string): string {
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) parts.push((i === 0 ? "" : " ") + line.slice(i, i + (i === 0 ? 75 : 74)));
  return parts.join("\r\n");
}

/** A vCard 3.0 for the Restock number `line` (E.164), saved as "restock" with the logo. */
export function contactCard(line: string): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${CONTACT_NAME};;;`,
    `FN:${CONTACT_NAME}`,
    `TEL;TYPE=CELL,VOICE:${line}`,
    `URL:${config.publicBaseUrl}`,
    "NOTE:Your household's restock assistant. Text what you need\\, like \"we're out of TP\".",
    `PHOTO;ENCODING=b;TYPE=PNG:${contactPhoto().toString("base64")}`,
    "END:VCARD",
  ]
    .map(fold)
    .join("\r\n") + "\r\n";
}

/** Where someone downloads the card for their Restock number. */
export function contactLink(line: string): string {
  return `${config.publicBaseUrl}/contact/${encodeURIComponent(line)}.vcf`;
}
