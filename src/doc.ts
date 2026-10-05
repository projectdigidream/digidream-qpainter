import type { FileRef } from './io';
import { makeCtx, type Ctx, type Rect, type RGBA, type Sym } from './paint';
import { SKY_DEFAULTS, skyMap, type SkyKind } from './sky';

/**
 * Animation: every layer holds one image ("cel") per frame; `data` always points at the current
 * frame's cel, so tools only ever see `layer.data`.
 */
export type Layer = { name: string; cels: ImageData[]; data: ImageData; visible: boolean; opacity: number };
type Entry =
  | { layer: number; frame: number; r: Rect; before: Uint8ClampedArray; after: Uint8ClampedArray }
  | { doc: Snapshot; after: Snapshot };
type Snapshot = { w: number; h: number; layers: Layer[]; active: number; frame: number };

export function newLayer(name: string, w: number, h: number, frames = 1): Layer {
  const cels = Array.from({ length: frames }, () => new ImageData(w, h));
  return { name, cels, data: cels[0], visible: true, opacity: 1 };
}
const copyImg = (i: ImageData) => new ImageData(i.data.slice(), i.width, i.height);

// Sweetie 16
export const DEFAULT_PALETTE: RGBA[] = '1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57'
  .split(' ').map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(255) as RGBA);

// ponytail: snapshots copy every cel of every layer; fine for textures, heavy for long 1024² animations
const cloneLayer = (l: Layer, frame: number): Layer => { const cels = l.cels.map(copyImg); return { ...l, cels, data: cels[frame] }; };

function crop(src: Uint8ClampedArray, w: number, r: Rect) {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(src.subarray(((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
function paste(dst: Uint8ClampedArray, w: number, r: Rect, data: Uint8ClampedArray) {
  for (let y = 0; y < r.h; y++) dst.set(data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * w + r.x) * 4);
}

export class Doc {
  id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  name = 'Untitled';
  /** Linked file that Save overwrites (as a project or a flattened PNG). */
  file: { ref: FileRef; kind: 'project' | 'png' } | null = null;
  /** Changed since last written to `file`. */
  unsaved = false;
  w: number;
  h: number;
  layers: Layer[];
  active = 0;
  frame = 0;
  fps = 8;
  palette: RGBA[] = DEFAULT_PALETTE.map((c) => [...c] as RGBA);
  ramps: RGBA[][] = [];
  sel: Rect | null = null;
  settings = { wrap: false, sym: 'none' as Sym, radial: 4, ax: 0, ay: 0, lock: false, snap: 'nearest' as 'nearest' | 'dither', sky: null as SkyKind | null, skyParams: { ...SKY_DEFAULTS } };
  comp = document.createElement('canvas');
  onChange = (_final: boolean) => {};
  /** Called before any new edit; commits a pending floating selection. */
  flush = () => {};
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  private snap: Uint8ClampedArray<ArrayBuffer> | null = null;
  private tmp = document.createElement('canvas');

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.layers = [newLayer('Layer 1', w, h)];
    this.settings.ax = w / 2;
    this.settings.ay = h / 2;
  }

  get layer() { return this.layers[this.active]; }
  get frames() { return this.layers[0].cels.length; }

  /** Show frame `i` (wraps around). Navigation only, not an undo step. */
  setFrame(i: number) {
    this.flush();
    this.frame = ((i % this.frames) + this.frames) % this.frames;
    for (const l of this.layers) l.data = l.cels[this.frame];
    this.changed();
  }
  addFrame(copy: boolean) {
    this.structural(() => {
      for (const l of this.layers) l.cels.splice(this.frame + 1, 0, copy ? copyImg(l.data) : new ImageData(this.w, this.h));
      this.frame++;
      for (const l of this.layers) l.data = l.cels[this.frame];
    });
  }
  deleteFrame() {
    if (this.frames < 2) return;
    this.structural(() => {
      for (const l of this.layers) l.cels.splice(this.frame, 1);
      this.frame = Math.min(this.frame, this.frames - 1);
      for (const l of this.layers) l.data = l.cels[this.frame];
    });
  }
  moveFrame(dir: -1 | 1) {
    const to = this.frame + dir;
    if (to < 0 || to >= this.frames) return;
    this.structural(() => {
      for (const l of this.layers) [l.cels[this.frame], l.cels[to]] = [l.cels[to], l.cels[this.frame]];
      this.frame = to;
      for (const l of this.layers) l.data = l.cels[to];
    });
  }
  /** Cut a single-frame sprite sheet (frames stacked vertically or side by side) into `n` frames. */
  splitFrames(n: number, vertical: boolean) {
    const fw = vertical ? this.w : this.w / n, fh = vertical ? this.h / n : this.h;
    if (this.frames !== 1 || n < 2 || !Number.isInteger(fw) || !Number.isInteger(fh)) return false;
    this.structural(() => {
      const g = document.createElement('canvas').getContext('2d')!;
      g.canvas.width = this.w;
      g.canvas.height = this.h;
      for (const l of this.layers) {
        g.putImageData(l.data, 0, 0);
        l.cels = Array.from({ length: n }, (_, k) => g.getImageData(vertical ? 0 : k * fw, vertical ? k * fh : 0, fw, fh));
        l.data = l.cels[0];
      }
      Object.assign(this, { w: fw, h: fh, frame: 0, sel: null });
      Object.assign(this.settings, { ax: fw / 2, ay: fh / 2 });
    });
    return true;
  }

  ctx(o: Partial<Ctx> = {}): Ctx {
    const s = this.settings;
    return makeCtx(this.layer.data, {
      // skyboxes have their own edges (cube faces / panorama wrap); symmetry copies would lose track of their face
      wrap: s.wrap, sym: s.sky === 'cube' ? 'none' : s.sym, radial: s.radial, ax: s.ax, ay: s.ay,
      map: s.sky ? skyMap(s.sky, this.w, this.h) : null,
      lock: s.lock ? this.palette : null, snap: s.snap, sel: this.sel, ...o,
    });
  }

  // ---- pixel edits (one stroke = one undo entry) ----
  begin() { this.flush(); this.snap = this.layer.data.data.slice(); }
  /** Pixels of the active layer as they were at stroke start (shares the buffer: read-only). */
  snapshot() { return new ImageData(this.snap!, this.w, this.h); }
  restore() { if (this.snap) this.layer.data.data.set(this.snap); }
  cancel() { this.restore(); this.snap = null; this.changed(true); }
  end(dirty: Rect | null) {
    if (!this.snap) return;
    if (dirty) {
      this.push({ layer: this.active, frame: this.frame, r: { ...dirty }, before: crop(this.snap, this.w, dirty), after: crop(this.layer.data.data, this.w, dirty) });
    }
    this.snap = null;
    this.changed(true);
  }
  /** Run a whole-layer pixel op as one undo step. */
  edit(fn: (img: ImageData) => void) {
    this.begin();
    fn(this.layer.data);
    this.end({ x: 0, y: 0, w: this.w, h: this.h });
  }

  // ---- structural edits (layers, size) ----
  private state = (): Snapshot => ({ w: this.w, h: this.h, layers: this.layers.map((l) => cloneLayer(l, this.frame)), active: this.active, frame: this.frame });
  private apply(s: Snapshot) {
    Object.assign(this, { w: s.w, h: s.h, layers: s.layers.map((l) => cloneLayer(l, s.frame)), active: s.active, frame: s.frame });
  }
  structural(fn: () => void) {
    this.flush();
    const before = this.state();
    fn();
    this.push({ doc: before, after: this.state() });
    this.changed(true);
  }

  private push(e: Entry) {
    this.undos.push(e);
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
  }
  /** One fully transparent layer: nothing worth keeping. */
  get blank() { return this.layers.length === 1 && this.frames === 1 && this.layer.data.data.every((v) => v === 0); }
  undo() { this.flush(); this.step(this.undos, this.redos, true); }
  redo() { this.flush(); this.step(this.redos, this.undos, false); }
  private step(from: Entry[], to: Entry[], back: boolean) {
    const e = from.pop();
    if (!e) return;
    if ('doc' in e) this.apply(back ? e.doc : e.after);
    else {
      // jump to the frame the edit was made in, so you see what changed
      if (e.frame !== this.frame) { this.frame = e.frame; for (const l of this.layers) l.data = l.cels[e.frame]; }
      paste(this.layers[e.layer].cels[e.frame].data, this.w, e.r, back ? e.before : e.after);
    }
    to.push(e);
    this.changed(true);
  }

  /** Recomposite visible layers into `comp`; `final` = stroke/edit finished (autosave etc.). */
  changed(final = false) {
    this.composite(this.frame, this.comp);
    this.onChange(final);
  }
  /** Flatten the visible layers of `frame` into `out` (resized to the doc). */
  composite(frame: number, out: HTMLCanvasElement) {
    const { tmp } = this;
    if (out.width !== this.w || out.height !== this.h) Object.assign(out, { width: this.w, height: this.h });
    if (tmp.width !== this.w || tmp.height !== this.h) Object.assign(tmp, { width: this.w, height: this.h });
    const cg = out.getContext('2d')!, tg = tmp.getContext('2d')!;
    cg.clearRect(0, 0, this.w, this.h);
    for (const l of this.layers) {
      if (!l.visible) continue;
      tg.putImageData(l.cels[frame], 0, 0);
      cg.globalAlpha = l.opacity;
      cg.drawImage(tmp, 0, 0);
    }
    cg.globalAlpha = 1;
  }

  flattened(): ImageData { return this.comp.getContext('2d')!.getImageData(0, 0, this.w, this.h); }
}
