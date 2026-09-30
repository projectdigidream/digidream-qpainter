// Pure raster core. Every tool paints through `plot`, so wrap, symmetry,
// selection clipping and palette lock apply to all of them uniformly.

export type RGBA = [number, number, number, number];
export type Sym = 'none' | 'x' | 'y' | 'xy' | 'diag' | 'radial';
export type Rect = { x: number; y: number; w: number; h: number };
/** Per-pixel op: current color at final (x,y) + brush coverage a∈[0,1] → new color, or null to skip. */
export type PixelFn = (dst: RGBA, x: number, y: number, a: number) => RGBA | null;

export interface Ctx {
  img: ImageData;
  wrap: boolean;
  sym: Sym;
  radial: number;
  ax: number; // symmetry center, in pixel-edge coords (w/2 = between the middle pixels)
  ay: number;
  lock: RGBA[] | null; // palette lock
  snap: 'nearest' | 'dither';
  sel: Rect | null;
  mask: Uint8Array | null; // opt-in: each pixel is touched at most once per stroke
  dirty: Rect | null;
}

export const makeCtx = (img: ImageData, o: Partial<Ctx> = {}): Ctx => ({
  img, wrap: false, sym: 'none', radial: 4, ax: img.width / 2, ay: img.height / 2,
  lock: null, snap: 'nearest', sel: null, mask: null, dirty: null, ...o,
});

export const mod = (a: number, n: number) => ((a % n) + n) % n;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const eq = (a: RGBA, b: RGBA) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
export const diff = (a: RGBA, b: RGBA) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
const d2 = (a: RGBA, b: RGBA) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export const getPx = (img: ImageData, x: number, y: number): RGBA => {
  const o = (y * img.width + x) * 4, d = img.data;
  return [d[o], d[o + 1], d[o + 2], d[o + 3]];
};

/** Symmetric copies of pixel (x,y), deduplicated. */
export function expand(c: Ctx, x: number, y: number): [number, number][] {
  const dx = x + 0.5 - c.ax, dy = y + 0.5 - c.ay;
  const offs: [number, number][] = [[dx, dy]];
  if (c.sym === 'x') offs.push([-dx, dy]);
  else if (c.sym === 'y') offs.push([dx, -dy]);
  else if (c.sym === 'xy') offs.push([-dx, dy], [dx, -dy], [-dx, -dy]);
  else if (c.sym === 'diag') offs.push([dy, dx]);
  else if (c.sym === 'radial')
    for (let k = 1; k < c.radial; k++) {
      const t = (2 * Math.PI * k) / c.radial, co = Math.cos(t), s = Math.sin(t);
      offs.push([dx * co - dy * s, dx * s + dy * co]);
    }
  const seen = new Set<string>(), out: [number, number][] = [];
  for (const [ox, oy] of offs) {
    const p: [number, number] = [Math.floor(r6(c.ax + ox)), Math.floor(r6(c.ay + oy))];
    const k = p.join();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

export function plot(c: Ctx, x: number, y: number, a: number, fn: PixelFn) {
  const { width: w, height: h, data } = c.img;
  for (let [px, py] of expand(c, x, y)) {
    if (c.wrap) { px = mod(px, w); py = mod(py, h); }
    else if (px < 0 || py < 0 || px >= w || py >= h) continue;
    if (c.sel && !inRect(c.sel, px, py)) continue;
    const i = py * w + px;
    if (c.mask) { if (c.mask[i]) continue; c.mask[i] = 1; }
    let out = fn(getPx(c.img, px, py), px, py, a);
    if (!out) continue;
    if (c.lock) out = snap(c.lock, out, px, py, c.snap);
    data.set(out, i * 4);
    const r = c.dirty;
    if (!r) c.dirty = { x: px, y: py, w: 1, h: 1 };
    else {
      const x1 = Math.max(r.x + r.w, px + 1), y1 = Math.max(r.y + r.h, py + 1);
      r.x = Math.min(r.x, px); r.y = Math.min(r.y, py); r.w = x1 - r.x; r.h = y1 - r.y;
    }
  }
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

// ---------- blending / palette ----------

/** Source-over blend of `src` with extra coverage a. */
export function blend(dst: RGBA, src: RGBA, a: number): RGBA {
  const sa = (src[3] / 255) * a, da = dst[3] / 255, oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  const ch = (k: number) => Math.round((src[k] * sa + dst[k] * da * (1 - sa)) / oa);
  return [ch(0), ch(1), ch(2), Math.round(oa * 255)];
}
export const erase = (dst: RGBA, a: number): RGBA => [dst[0], dst[1], dst[2], Math.round(dst[3] * (1 - a))];

export function nearestIdx(pal: RGBA[], c: RGBA): [number, number] {
  let i = 0, j = 0, di = Infinity, dj = Infinity;
  pal.forEach((p, k) => {
    const d = d2(p, c);
    if (d < di) { j = i; dj = di; i = k; di = d; } else if (d < dj) { j = k; dj = d; }
  });
  return [i, j];
}

/** Snap to palette: nearest color, or ordered-dither between the two nearest. Alpha is thresholded. */
export function snap(pal: RGBA[], c: RGBA, x: number, y: number, mode: 'nearest' | 'dither'): RGBA {
  if (c[3] < 128 || !pal.length) return [0, 0, 0, 0];
  const [i, j] = nearestIdx(pal, c);
  if (mode === 'nearest' || pal.length < 2) return [...pal[i]] as RGBA;
  const a = pal[i], b = pal[j];
  let num = 0, den = 0;
  for (let k = 0; k < 3; k++) { num += (c[k] - a[k]) * (b[k] - a[k]); den += (b[k] - a[k]) ** 2; }
  const t = den ? Math.min(1, Math.max(0, num / den)) : 0;
  return [...(t > threshold(PATTERNS.bayer4, x, y) ? b : a)] as RGBA;
}

// ---------- dither patterns (thresholds in world coords) ----------

export type Pattern = { n: number; t: number[] };
function bayer(n: number): number[] {
  if (n === 1) return [0];
  const h = n / 2, m = bayer(h), out: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) out.push(4 * m[(y % h) * h + (x % h)] + [0, 2, 3, 1][(y < h ? 0 : 2) + (x < h ? 0 : 1)]);
  return out;
}
const norm = (n: number, v: number[]): Pattern => ({ n, t: v.map((k) => (k + 0.5) / v.length) });
export const PATTERNS: Record<string, Pattern> = {
  checker: { n: 2, t: [0, 1, 1, 0] }, // fixed 50%
  bayer2: norm(2, bayer(2)),
  bayer4: norm(4, bayer(4)),
  bayer8: norm(8, bayer(8)),
  linesH: { n: 2, t: [0.25, 0.25, 0.75, 0.75] },
  linesV: { n: 2, t: [0.25, 0.75, 0.25, 0.75] },
  diag: { n: 4, t: Array.from({ length: 16 }, (_, i) => ((((i % 4) + Math.floor(i / 4)) % 4) + 0.5) / 4) },
  custom: { n: 8, t: Array.from({ length: 64 }, (_, i) => ((i % 8) + Math.floor(i / 8)) % 2) }, // edited in UI
};
export const threshold = (p: Pattern, x: number, y: number) => p.t[mod(y, p.n) * p.n + mod(x, p.n)];
/** Pattern moved right/down by (ox, oy) pixels, wrapping within its period. */
export const shiftPattern = (p: Pattern, ox: number, oy: number): Pattern =>
  ({ n: p.n, t: p.t.map((_, i) => threshold(p, (i % p.n) - ox, Math.floor(i / p.n) - oy)) });
/** Pattern picks primary where threshold < density. */
export const ditherFn = (p: Pattern, density: number, a: RGBA, b: RGBA | null): PixelFn =>
  (_d, x, y) => (threshold(p, x, y) < density ? a : b);

// ---------- mixing brushes ----------

export function rampStep(ramps: RGBA[][], dst: RGBA, dir: number): RGBA | null {
  for (const r of ramps) {
    const i = r.findIndex((c) => eq(c, dst));
    if (i >= 0) return r[Math.min(r.length - 1, Math.max(0, i + dir))];
  }
  return null;
}
export const hash = (x: number, y: number, seed: number) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Average with 4-neighbours, snapped to palette: hand-AA / smoothing helper. */
export const smoothFn = (img: ImageData, pal: RGBA[], wrap: boolean): PixelFn => (dst, x, y) => {
  const s = [0, 0, 0, 0];
  let n = 0;
  for (const [ox, oy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let px = x + ox, py = y + oy;
    if (wrap) { px = mod(px, img.width); py = mod(py, img.height); }
    else if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
    const c = getPx(img, px, py);
    for (let k = 0; k < 4; k++) s[k] += c[k];
    n++;
  }
  const avg = s.map((v) => v / n) as RGBA;
  return dst[3] < 128 || !pal.length ? null : [...pal[nearestIdx(pal, avg)[0]]] as RGBA;
};

// ---------- geometry ----------

export function line(x0: number, y0: number, x1: number, y1: number, cb: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    cb(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
/** Float walk for soft brushes. */
export function walk(x0: number, y0: number, x1: number, y1: number, step: number, cb: (x: number, y: number) => void) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(0.25, step)));
  for (let i = 1; i <= n; i++) cb(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
}

export function stamp(c: Ctx, x: number, y: number, size: number, hardness: number, fn: PixelFn) {
  if (size <= 1) return plot(c, Math.floor(x), Math.floor(y), 1, fn);
  const r = size / 2;
  if (hardness >= 1) { x = size % 2 ? Math.floor(x) + 0.5 : Math.round(x); y = size % 2 ? Math.floor(y) + 0.5 : Math.round(y); }
  for (let py = Math.floor(y - r); py < y + r; py++)
    for (let px = Math.floor(x - r); px < x + r; px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y) / r;
      if (d > 1) continue;
      plot(c, px, py, hardness >= 1 || d <= hardness ? 1 : (1 - d) / (1 - hardness), fn);
    }
}

export function rectPts(x0: number, y0: number, x1: number, y1: number, filled: boolean): [number, number][] {
  const out: [number, number][] = [];
  const [ax, bx, ay, by] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) out.push([x, y]);
  return out;
}
export function ellipsePts(x0: number, y0: number, x1: number, y1: number, filled: boolean): [number, number][] {
  const [ax, bx, ay, by] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (ax + bx + 1) / 2, cy = (ay + by + 1) / 2, rx = (bx - ax + 1) / 2, ry = (by - ay + 1) / 2;
  const inside = (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
  const out: [number, number][] = [];
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++)
      if (inside(x, y) && (filled || !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1))) out.push([x, y]);
  return out;
}

/** Pixel indices to fill from seed (4-connected, wrap-aware), or all matching if !contiguous. */
export function floodRegion(img: ImageData, x: number, y: number, wrap: boolean, tol: number, contiguous: boolean): number[] {
  const { width: w, height: h } = img, target = getPx(img, x, y), out: number[] = [];
  const match = (i: number) => diff(getPx(img, i % w, Math.floor(i / w)), target) <= tol;
  if (!contiguous) { for (let i = 0; i < w * h; i++) if (match(i)) out.push(i); return out; }
  const seen = new Uint8Array(w * h), stack = [y * w + x];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    out.push(i);
    const px = i % w, py = Math.floor(i / w);
    for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
      let qx = nx, qy = ny;
      if (wrap) { qx = mod(qx, w); qy = mod(qy, h); } else if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const j = qy * w + qx;
      if (!seen[j] && match(j)) { seen[j] = 1; stack.push(j); }
    }
  }
  return out;
}

/** Dithered gradient along p0→p1 through `colors` (a ramp). Ignores symmetry; respects wrap/sel/lock. */
export function gradient(c: Ctx, x0: number, y0: number, x1: number, y1: number, colors: RGBA[], radial: boolean, p: Pattern) {
  const cc: Ctx = { ...c, sym: 'none', mask: null };
  const vx = x1 - x0, vy = y1 - y0, L2 = vx * vx + vy * vy || 1, n = colors.length;
  const { width: w, height: h } = c.img;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - x0, py = y + 0.5 - y0;
      const t = Math.min(1, Math.max(0, radial ? Math.sqrt((px * px + py * py) / L2) : (px * vx + py * vy) / L2));
      const pos = t * (n - 1), i = Math.min(n - 2, Math.floor(pos));
      const col = n < 2 ? colors[0] : pos - i > threshold(p, x, y) ? colors[i + 1] : colors[i];
      plot(cc, x, y, 1, () => col);
    }
  c.dirty = cc.dirty;
}

export function offset(img: ImageData, dx: number, dy: number): ImageData {
  const { width: w, height: h } = img, out = new ImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out.data.set(getPx(img, x, y), (mod(y + dy, h) * w + mod(x + dx, w)) * 4);
  return out;
}

/** In-place quantize to palette. */
export function remap(img: ImageData, pal: RGBA[], mode: 'nearest' | 'ordered' | 'fs', wrap: boolean) {
  const { width: w, height: h, data } = img;
  if (mode !== 'fs') {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) data.set(snap(pal, getPx(img, x, y), x, y, mode === 'ordered' ? 'dither' : 'nearest'), (y * w + x) * 4);
    return;
  }
  // In wrap mode, prepend a copy of the last rows as warm-up so row 0 receives the same error
  // it would get from the tile above: the result tiles vertically too.
  const K = wrap ? Math.min(h, 8) : 0, H = h + K, buf = new Float32Array(w * H * 4);
  buf.set(data.subarray((h - K) * w * 4));
  buf.set(data, K * w * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const c: RGBA = [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
      const out = snap(pal, c.map((v) => Math.min(255, Math.max(0, v))) as RGBA, x, y, 'nearest');
      if (y >= K) data.set(out, o - K * w * 4);
      if (c[3] < 128) continue;
      for (const [ox, oy, f] of [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]) {
        let nx = x + ox;
        const ny = y + oy;
        if (wrap) nx = mod(nx, w); else if (nx < 0 || nx >= w) continue;
        if (ny >= H) continue;
        const q = (ny * w + nx) * 4;
        for (let k = 0; k < 3; k++) buf[q + k] += ((c[k] - out[k]) * f) / 16;
      }
    }
}

/** Unique opaque colors; median-cut down to `max` if there are more. */
export function extractPalette(img: ImageData, max: number): RGBA[] {
  const map = new Map<number, RGBA>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const c: RGBA = [img.data[i], img.data[i + 1], img.data[i + 2], 255];
    map.set((c[0] << 16) | (c[1] << 8) | c[2], c);
  }
  const all = [...map.values()];
  if (all.length <= max) return all;
  const boxes = [all];
  while (boxes.length < max) {
    let best = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let k = 0; k < 3; k++) {
        const vs = b.map((c) => c[k]), r = Math.max(...vs) - Math.min(...vs);
        if (r > bestRange) { bestRange = r; best = i; bestCh = k; }
      }
    });
    if (best < 0) break;
    const b = boxes[best].sort((p, q) => p[bestCh] - q[bestCh]);
    boxes.splice(best, 1, b.slice(0, b.length >> 1), b.slice(b.length >> 1));
  }
  return boxes.map((b) => [0, 1, 2].map((k) => Math.round(b.reduce((s, c) => s + c[k], 0) / b.length)).concat(255) as RGBA);
}
