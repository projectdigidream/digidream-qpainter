// Minimal animated-PNG encoder: RGBA 8-bit, every frame full size, looping forever.
// Compression uses the platform's CompressionStream ('deflate' = zlib, as PNG requires).

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(b: Uint8Array) {
  let c = ~0;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
function chunk(type: string, data: ArrayLike<number>) {
  const body = new Uint8Array(4 + data.length);
  body.set([...type].map((c) => c.charCodeAt(0)));
  body.set(data, 4);
  return new Uint8Array([...u32(data.length), ...body, ...u32(crc32(body))]);
}

async function zlib(raw: Uint8Array) {
  const s = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Frames must all be the same size. `delayMs` is the time each frame is shown. */
export async function encodeApng(frames: { width: number; height: number; data: Uint8ClampedArray }[], delayMs: number): Promise<Uint8Array> {
  const { width: w, height: h } = frames[0];
  const parts: Uint8Array[] = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0]), // 8-bit RGBA
    chunk('acTL', [...u32(frames.length), ...u32(0)]), // 0 plays = loop forever
  ];
  let seq = 0;
  for (const [i, f] of frames.entries()) {
    // each scanline: filter byte 0 (none) + RGBA pixels
    const raw = new Uint8Array(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) raw.set(f.data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
    const z = await zlib(raw);
    // fcTL: size, offset 0,0, delay (ms/1000), dispose none, blend source (frames replace, alpha included)
    parts.push(chunk('fcTL', [...u32(seq++), ...u32(w), ...u32(h), ...u32(0), ...u32(0), ...u16(Math.round(delayMs)), ...u16(1000), 0, 0]));
    parts.push(i === 0 ? chunk('IDAT', z) : chunk('fdAT', [...u32(seq++), ...z]));
  }
  parts.push(chunk('IEND', []));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
