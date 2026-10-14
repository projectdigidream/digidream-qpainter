// Reads Aseprite files (.aseprite / .ase), following Aseprite's published format
// (github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md): layers, frames, cels, palette.
// Pure: returns full-canvas RGBA buffers; the caller turns them into a Doc.

export type AseColor = [number, number, number, number];
export type AseImport = {
  w: number;
  h: number;
  /** Frame durations in ms. */
  durations: number[];
  /** Visible-or-not layers, top-level and inside groups (flattened), bottom to top; one RGBA buffer per frame. */
  layers: { name: string; visible: boolean; opacity: number; cels: Uint8ClampedArray<ArrayBuffer>[] }[];
  palette: AseColor[];
  /** What couldn't be carried over exactly, in plain words. */
  warnings: string[];
};

type RawLayer = { name: string; flags: number; type: number; level: number; blend: number; opacity: number };
type RawCel = { layer: number; frame: number; x: number; y: number; opacity: number; w: number; h: number; px: Uint8Array | null; link: number };

const LAYER_VISIBLE = 1, LAYER_BACKGROUND = 8, LAYER_REFERENCE = 64;

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')); // zlib
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function readAseprite(buf: ArrayBuffer): Promise<AseImport> {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  const u8 = (o: number) => v.getUint8(o), u16 = (o: number) => v.getUint16(o, true), i16 = (o: number) => v.getInt16(o, true), u32 = (o: number) => v.getUint32(o, true);
  const str = (o: number) => new TextDecoder().decode(bytes.subarray(o + 2, o + 2 + u16(o)));
  if (buf.byteLength < 128 || u16(4) !== 0xa5e0) throw new Error('not an Aseprite file');

  const frames = u16(6), w = u16(8), h = u16(10), depth = u16(12), flags = u32(14), transparentIndex = u8(28);
  if (depth !== 32 && depth !== 16 && depth !== 8) throw new Error(`unsupported colour depth ${depth}`);
  const bpp = depth / 8, layerOpacityValid = (flags & 1) !== 0;
  const layers: RawLayer[] = [], cels: RawCel[] = [], durations: number[] = [], warnings = new Set<string>();
  let palette: AseColor[] = [], oldPalette: AseColor[] = [];

  let o = 128;
  for (let f = 0; f < frames; f++) {
    const frameBytes = u32(o);
    if (u16(o + 4) !== 0xf1fa) throw new Error(`frame ${f + 1} is damaged`);
    const oldCount = u16(o + 6), newCount = u32(o + 12);
    durations.push(u16(o + 8));
    let c = o + 16;
    for (let k = 0, n = newCount || oldCount; k < n; k++) {
      const size = u32(c), type = u16(c + 4), d = c + 6;
      if (type === 0x2004) {
        layers.push({ flags: u16(d), type: u16(d + 2), level: u16(d + 4), blend: u16(d + 10), opacity: u8(d + 12), name: str(d + 16) });
      } else if (type === 0x2005) {
        const cel: RawCel = { layer: u16(d), frame: f, x: i16(d + 2), y: i16(d + 4), opacity: u8(d + 6), w: 0, h: 0, px: null, link: -1 };
        const kind = u16(d + 7), p = d + 16;
        if (kind === 0) { cel.w = u16(p); cel.h = u16(p + 2); cel.px = bytes.slice(p + 4, p + 4 + cel.w * cel.h * bpp); }
        else if (kind === 1) cel.link = u16(p);
        else if (kind === 2) { cel.w = u16(p); cel.h = u16(p + 2); cel.px = await inflate(bytes.subarray(p + 4, c + size)); }
        else { warnings.add('Tilemap layers aren\'t supported and were left out.'); c += size; continue; }
        cels.push(cel);
      } else if (type === 0x2019) {
        const first = u32(d + 4), last = u32(d + 8);
        let e = d + 20;
        for (let i = first; i <= last; i++) {
          const ef = u16(e);
          palette[i] = [u8(e + 2), u8(e + 3), u8(e + 4), u8(e + 5)];
          e += 6 + (ef & 1 ? 2 + u16(e + 6) : 0);
        }
      } else if (type === 0x0004 || type === 0x0011) {
        // older palette chunks (0x0011 has 6-bit colours)
        const scale = type === 0x0011 ? 255 / 63 : 1;
        let e = d + 2, i = 0;
        for (let pk = 0, packets = u16(d); pk < packets; pk++) {
          i += u8(e);
          const count = u8(e + 1) || 256;
          e += 2;
          for (let q = 0; q < count; q++, i++, e += 3)
            oldPalette[i] = [Math.round(u8(e) * scale), Math.round(u8(e + 1) * scale), Math.round(u8(e + 2) * scale), 255];
        }
      }
      c += size;
    }
    o += frameBytes;
  }
  if (!palette.length) palette = oldPalette;

  // pixels to RGBA (indexed colours need the palette, which may come after the cels)
  const toRGBA = (px: Uint8Array, background: boolean): Uint8ClampedArray => {
    if (depth === 32) return new Uint8ClampedArray(px.buffer, px.byteOffset, px.length);
    const n = px.length / bpp, out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      if (depth === 16) out.set([px[i * 2], px[i * 2], px[i * 2], px[i * 2 + 1]], i * 4);
      else {
        const idx = px[i], col = palette[idx];
        if (col && (background || idx !== transparentIndex)) out.set(col, i * 4);
      }
    }
    return out;
  };

  // groups: a layer shows only if its groups do, and their opacity multiplies in; their names prefix it
  const out: AseImport['layers'] = [], index = new Map<number, number>(), groups: RawLayer[] = [];
  layers.forEach((l, i) => {
    groups.length = l.level;
    const chain = groups.filter(Boolean);
    if (l.type === 1) { groups[l.level] = l; return; }
    if (l.type === 2) { warnings.add('Tilemap layers aren\'t supported and were left out.'); return; }
    if (l.flags & LAYER_REFERENCE) return; // a reference picture for tracing, not part of the art
    if (l.blend !== 0) warnings.add('Layers with a blend mode other than Normal are drawn as Normal.');
    const op = (x: RawLayer) => (layerOpacityValid ? x.opacity / 255 : 1);
    index.set(i, out.length);
    out.push({
      name: [...chain.map((g) => g.name), l.name].join('/'),
      visible: [l, ...chain].every((x) => x.flags & LAYER_VISIBLE),
      opacity: [l, ...chain].reduce((a, x) => a * op(x), 1),
      cels: Array.from({ length: frames }, () => new Uint8ClampedArray(w * h * 4)),
    });
  });

  // place each cel on its layer's full-size frame; linked cels share another frame's cel
  const find = (layer: number, frame: number) => cels.find((x) => x.layer === layer && x.frame === frame);
  for (const cel of cels) {
    const li = index.get(cel.layer);
    if (li === undefined) continue;
    const src = cel.link >= 0 ? find(cel.layer, cel.link) : cel;
    if (!src?.px) continue;
    const rgba = toRGBA(src.px, (layers[cel.layer].flags & LAYER_BACKGROUND) !== 0), dst = out[li].cels[cel.frame], a = cel.opacity / 255;
    for (let y = 0; y < src.h; y++) {
      const ty = src.y + y;
      if (ty < 0 || ty >= h) continue;
      for (let x = 0; x < src.w; x++) {
        const tx = src.x + x;
        if (tx < 0 || tx >= w) continue;
        const s = (y * src.w + x) * 4, t = (ty * w + tx) * 4;
        dst.set([rgba[s], rgba[s + 1], rgba[s + 2], Math.round(rgba[s + 3] * a)], t);
      }
    }
  }

  if (new Set(durations).size > 1) warnings.add('Frames have different durations; qPainter plays every frame for the same time (the most common duration).');
  return { w, h, durations, layers: out, palette: palette.filter(Boolean).map((c) => [c[0], c[1], c[2], 255] as AseColor), warnings: [...warnings] };
}

/** One speed for the whole animation: the most common frame duration, as frames per second. */
export function aseFps(durations: number[]): number {
  const count = new Map<number, number>();
  for (const d of durations) count.set(d, (count.get(d) ?? 0) + 1);
  const ms = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || 100;
  return Math.min(60, Math.max(1, Math.round(1000 / ms)));
}
