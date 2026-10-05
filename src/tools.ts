import type { Doc } from './doc';
import {
  PATTERNS, blend, diff, ditherFn, shiftPattern, ellipsePts, erase, floodRegion, getPx, gradient, hash, line, mod, offset, plot,
  inRect, rampStep, rectPts, smoothFn, stamp, walk, type Ctx, type PixelFn, type Rect, type RGBA,
} from './paint';

export type P = { x: number; y: number; pressure: number; shift: boolean; alt: boolean; right: boolean };
export type Tool = { down(p: P): void; move(p: P): void; up(p: P): void };

export const opts = {
  primary: [26, 28, 44, 255] as RGBA,
  secondary: [244, 244, 244, 255] as RGBA,
  size: 1, hardness: 0.5, opacity: 1, pSize: true, pOpacity: false, pixelPerfect: true,
  pattern: 'bayer4', patX: 0, patY: 0, density: 0.5, ditherBg: false, pDensity: false,
  tol: 0, contiguous: true, fillDither: false, filled: false,
  radialGrad: false, useRamp: false, ramp: 0, noise: 0.3,
};

const color = (p: P) => (p.right ? opts.secondary : opts.primary);
const solid = (c: RGBA, op = 1): PixelFn => (d, _x, _y, a) => blend(d, c, a * op);
const ip = (p: P) => [Math.floor(p.x), Math.floor(p.y)] as const;
const activeRamp = (doc: Doc) => doc.ramps[opts.ramp] ?? doc.ramps[0];
/** Current dither pattern with the user's offset applied. */
export const pattern = () => shiftPattern(PATTERNS[opts.pattern], opts.patX, opts.patY);

/** Freehand stroke: `fn` is rebuilt per stamp so pressure can drive it. */
function brushTool(doc: Doc, cfg: { hard?: boolean; mask?: boolean; fn: (p: P, c: Ctx) => PixelFn; start?: (p: P) => void }): Tool {
  let c: Ctx, last: P, pts: [number, number][] = [];
  const hardness = () => (cfg.hard ? 1 : opts.hardness);
  const size = (p: P) => Math.max(1, Math.round(opts.size * (opts.pSize ? p.pressure : 1)));
  const dab = (p: P, x: number, y: number) => {
    const s = size(p);
    if (s === 1 && hardness() === 1) {
      const [ix, iy] = [Math.floor(x), Math.floor(y)];
      const prev = pts[pts.length - 1];
      if (prev && prev[0] === ix && prev[1] === iy) return;
      pts.push([ix, iy]);
      plot(c, ix, iy, 1, cfg.fn(p, c));
      // pixel-perfect: drop the middle pixel of an L-corner
      if (opts.pixelPerfect && pts.length >= 3) {
        const [a, b, d] = pts.slice(-3);
        if (Math.abs(a[0] - d[0]) === 1 && Math.abs(a[1] - d[1]) === 1) {
          const snap = doc.snapshot();
          plot({ ...c, lock: null, mask: null }, b[0], b[1], 1, (_d, x, y) => getPx(snap, x, y));
          pts.splice(-2, 1);
        }
      }
    } else stamp(c, x, y, s, hardness(), cfg.fn(p, c));
  };
  return {
    down(p) {
      doc.begin();
      c = doc.ctx({ mask: cfg.mask || cfg.hard ? new Uint8Array(doc.w * doc.h) : null });
      pts = [];
      cfg.start?.(p);
      last = p;
      dab(p, p.x, p.y);
      doc.changed();
    },
    move(p) {
      const s = size(p);
      if (s === 1 && hardness() === 1) line(Math.floor(last.x), Math.floor(last.y), Math.floor(p.x), Math.floor(p.y), (x, y) => dab(p, x, y));
      else walk(last.x, last.y, p.x, p.y, s * 0.2, (x, y) => dab(p, x, y));
      last = p;
      doc.changed();
    },
    up() { doc.end(c.dirty); },
  };
}

/** Drag-to-define tools that redraw from the stroke snapshot on every move. */
function dragTool(doc: Doc, draw: (c: Ctx, a: P, b: P) => void): Tool {
  let a: P, c: Ctx;
  const redraw = (b: P) => { doc.restore(); c = doc.ctx(); draw(c, a, b); doc.changed(); };
  return {
    down(p) { doc.begin(); a = p; redraw(p); },
    move: redraw,
    up() { doc.end(c.dirty); },
  };
}

function constrain(a: P, b: P, square: boolean): [number, number] {
  let [x, y] = ip(b);
  const [ax, ay] = ip(a);
  if (!b.shift) return [x, y];
  const dx = x - ax, dy = y - ay, m = Math.max(Math.abs(dx), Math.abs(dy));
  if (square) return [ax + Math.sign(dx) * m, ay + Math.sign(dy) * m];
  // snap line to 0/45/90°
  if (Math.abs(dx) > 2 * Math.abs(dy)) y = ay; else if (Math.abs(dy) > 2 * Math.abs(dx)) x = ax;
  else { x = ax + Math.sign(dx) * m; y = ay + Math.sign(dy) * m; }
  return [x, y];
}

export function makeTools(doc: Doc, onPick: () => void) {
  const shape = (pts: (a: readonly [number, number], b: [number, number], filled: boolean) => [number, number][], square: boolean) =>
    dragTool(doc, (c, a, b) => {
      const fn = solid(color(b), opts.opacity);
      c.mask = new Uint8Array(doc.w * doc.h);
      for (const [x, y] of pts(ip(a), constrain(a, b, square), opts.filled)) stamp(c, x + 0.5, y + 0.5, opts.filled ? 1 : opts.size, 1, fn);
    });

  let noiseSeed = 0, replaceTarget: RGBA = [0, 0, 0, 0];
  let grab: [number, number] | null = null, layerDrag: { img: ImageData; a: P } | null = null;
  let selStart: P | null = null;
  doc.flush = () => commitFloat(doc);

  const tools: Record<string, Tool> = {
    pencil: brushTool(doc, { hard: true, fn: (p) => solid(color(p), opts.opacity * (opts.pOpacity ? p.pressure : 1)) }),
    brush: brushTool(doc, { fn: (p) => solid(color(p), opts.opacity * (opts.pOpacity ? p.pressure : 1)) }),
    eraser: brushTool(doc, { fn: (p) => (d, _x, _y, a) => erase(d, a * opts.opacity * (opts.pOpacity ? p.pressure : 1)) }),
    dither: brushTool(doc, {
      hard: true,
      fn: (p) => ditherFn(pattern(), opts.density * (opts.pDensity ? p.pressure : 1), color(p), opts.ditherBg ? (p.right ? opts.primary : opts.secondary) : null),
    }),
    shade: brushTool(doc, { hard: true, mask: true, fn: (p) => (d) => rampStep(doc.ramps, d, p.right || p.shift ? -1 : 1) }),
    noise: brushTool(doc, {
      hard: true, mask: true,
      start: () => { noiseSeed = (Math.random() * 1e9) | 0; },
      fn: (p) => (_d, x, y) => {
        if (hash(x, y, noiseSeed) >= opts.noise) return null;
        const r = opts.useRamp && activeRamp(doc);
        const cols = r && r.length ? r : [opts.primary, opts.secondary];
        return cols[Math.floor(hash(x, y, noiseSeed + 1) * cols.length)] ?? color(p);
      },
    }),
    replace: brushTool(doc, {
      hard: true,
      start: (p) => { const [x, y] = ip(p); replaceTarget = getPx(doc.layer.data, mod(x, doc.w), mod(y, doc.h)); },
      fn: (p) => (d) => (diff(d, replaceTarget) <= opts.tol ? color(p) : null),
    }),
    smooth: brushTool(doc, {
      hard: true, mask: true,
      fn: (_p, c) => smoothFn(doc.snapshot(), doc.palette, c.wrap),
    }),
    line: shape((a, b) => { const out: [number, number][] = []; line(a[0], a[1], b[0], b[1], (x, y) => out.push([x, y])); return out; }, false),
    rect: shape((a, b, f) => rectPts(a[0], a[1], b[0], b[1], f), true),
    ellipse: shape((a, b, f) => ellipsePts(a[0], a[1], b[0], b[1], f), true),
    gradient: dragTool(doc, (c, a, b) => {
      const r = opts.useRamp && activeRamp(doc);
      const cols = r && r.length > 1 ? r : [opts.primary, opts.secondary];
      gradient(c, a.x, a.y, b.x, b.y, b.right ? [...cols].reverse() : cols, opts.radialGrad, pattern());
    }),
    fill: {
      down(p) {
        let [x, y] = ip(p);
        if (doc.settings.wrap) { x = mod(x, doc.w); y = mod(y, doc.h); }
        if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
        doc.begin();
        const c = doc.ctx();
        const fn = opts.fillDither ? ditherFn(pattern(), opts.density, color(p), opts.ditherBg ? (p.right ? opts.primary : opts.secondary) : null) : solid(color(p), opts.opacity);
        for (const i of floodRegion(doc.layer.data, x, y, c.wrap, opts.tol, opts.contiguous, c.map)) plot(c, i % doc.w, Math.floor(i / doc.w), 1, fn);
        doc.end(c.dirty);
      },
      move() {}, up() {},
    },
    picker: {
      down(p) {
        const [x, y] = ip(p);
        if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
        const c = getPx(doc.flattened(), x, y);
        if (c[3] === 0) return;
        if (p.right) opts.secondary = c; else opts.primary = c;
        onPick();
      },
      move(p) { this.down(p); }, up() {},
    },
    select: {
      down(p) { commitFloat(doc); selStart = p; doc.sel = null; doc.changed(); },
      move(p) {
        if (!selStart) return;
        const [ax, ay] = ip(selStart), [bx, by] = ip(p);
        const x = Math.max(0, Math.min(ax, bx)), y = Math.max(0, Math.min(ay, by));
        const w = Math.min(doc.w, Math.max(ax, bx) + 1) - x, h = Math.min(doc.h, Math.max(ay, by) + 1) - y;
        doc.sel = w > 0 && h > 0 ? { x, y, w, h } : null;
        doc.changed();
      },
      up() { selStart = null; },
    },
    // Inside a selection: lift it into a floating selection and drag it (Alt = copy). Outside: offset the whole layer with wrap.
    move: {
      down(p) {
        const [x, y] = ip(p);
        if (float && doc.sel && inRect(doc.sel, x, y)) { grab = [x - float.x, y - float.y]; return; }
        commitFloat(doc);
        const sel = doc.sel;
        if (sel && inRect(sel, x, y)) {
          lift(doc, cropImg(doc.layer.data, sel), sel.x, sel.y, p.alt ? null : sel);
          grab = [x - sel.x, y - sel.y];
          return;
        }
        doc.sel = null;
        doc.begin();
        layerDrag = { img: doc.snapshot(), a: p };
      },
      move(p) {
        const [x, y] = ip(p);
        if (grab && float) {
          if (float.x === x - grab[0] && float.y === y - grab[1]) return;
          float.x = x - grab[0];
          float.y = y - grab[1];
          drawFloat(doc);
        } else if (layerDrag) {
          doc.layer.data.data.set(offset(layerDrag.img, Math.round(p.x - layerDrag.a.x), Math.round(p.y - layerDrag.a.y)).data);
          doc.changed();
        }
      },
      up() {
        grab = null;
        if (layerDrag) { layerDrag = null; doc.end({ x: 0, y: 0, w: doc.w, h: doc.h }); }
      },
    },
  };
  return tools;
}

// ---- floating selection ----
// Moved or pasted pixels float above the layer until committed (other tool, Enter, deselect), so
// dragging never destroys what's underneath. The whole float session is one undo step.

type Float = { img: ImageData; x: number; y: number; base: Uint8ClampedArray };
let float: Float | null = null;
const full = (doc: Doc) => ({ x: 0, y: 0, w: doc.w, h: doc.h });

function cropImg(src: ImageData, r: Rect) {
  const out = new ImageData(r.w, r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) out.data.set(getPx(src, r.x + x, r.y + y), (y * r.w + x) * 4);
  return out;
}
function drawFloat(doc: Doc) {
  const f = float!, layer = doc.layer.data;
  layer.data.set(f.base);
  for (let y = 0; y < f.img.height; y++)
    for (let x = 0; x < f.img.width; x++) {
      const c = getPx(f.img, x, y);
      let X = f.x + x, Y = f.y + y;
      if (!c[3]) continue;
      if (doc.settings.wrap) { X = mod(X, doc.w); Y = mod(Y, doc.h); } else if (X < 0 || Y < 0 || X >= doc.w || Y >= doc.h) continue;
      layer.data.set(blend(getPx(layer, X, Y), c, 1), (Y * doc.w + X) * 4);
    }
  doc.sel = { x: f.x, y: f.y, w: f.img.width, h: f.img.height };
  doc.changed();
}
/** Start floating `img` at (x,y), optionally cutting `cut` out of the layer first. */
function lift(doc: Doc, img: ImageData, x: number, y: number, cut: Rect | null) {
  commitFloat(doc);
  doc.begin();
  if (cut) for (let yy = cut.y; yy < cut.y + cut.h; yy++) doc.layer.data.data.fill(0, (yy * doc.w + cut.x) * 4, (yy * doc.w + cut.x + cut.w) * 4);
  float = { img, x, y, base: doc.layer.data.data.slice() };
  drawFloat(doc);
}
export function commitFloat(doc: Doc) {
  if (!float) return;
  float = null;
  doc.end(full(doc));
}
export function cancelFloat(doc: Doc) {
  if (!float) return false;
  float = null;
  doc.sel = null;
  doc.cancel();
  return true;
}

// ---- selection / whole-layer ops ----
// ---- selection / whole-layer ops ----

export let clipboard: ImageData | null = null;
export const setClipboard = (img: ImageData) => { clipboard = img; };

const region = (doc: Doc) => doc.sel ?? { x: 0, y: 0, w: doc.w, h: doc.h };
export function copySel(doc: Doc) {
  clipboard = float ? float.img : cropImg(doc.layer.data, region(doc));
}
export function clearSel(doc: Doc) {
  if (float) { doc.layer.data.data.set(float.base); float = null; doc.sel = null; return doc.end(full(doc)); }
  const r = region(doc);
  doc.edit((img) => { for (let y = r.y; y < r.y + r.h; y++) img.data.fill(0, (y * doc.w + r.x) * 4, (y * doc.w + r.x + r.w) * 4); });
}
/** Paste the clipboard as a floating selection at the current selection's corner. */
export function pasteClip(doc: Doc) {
  if (clipboard) lift(doc, clipboard, doc.sel?.x ?? 0, doc.sel?.y ?? 0, null);
}
/** Flip (h/v) or rotate 90° CW the selection (rotation needs a square region). */
export function transformSel(doc: Doc, kind: 'h' | 'v' | 'rot') {
  if (float) {
    const src = float.img, [w, h] = kind === 'rot' ? [src.height, src.width] : [src.width, src.height], out = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [sx, sy] = kind === 'h' ? [w - 1 - x, y] : kind === 'v' ? [x, h - 1 - y] : [y, h - 1 - x];
        out.data.set(getPx(src, sx, sy), (y * w + x) * 4);
      }
    float.img = out;
    return drawFloat(doc);
  }
  const r = region(doc);
  if (kind === 'rot' && r.w !== r.h) return alert('Rotate needs a square selection (or square texture).');
  doc.edit((img) => {
    const src = new ImageData(img.data.slice(), doc.w, doc.h);
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const [sx, sy] = kind === 'h' ? [r.w - 1 - x, y] : kind === 'v' ? [x, r.h - 1 - y] : [y, r.w - 1 - x];
        img.data.set(getPx(src, r.x + sx, r.y + sy), ((r.y + y) * doc.w + r.x + x) * 4);
      }
  });
}
