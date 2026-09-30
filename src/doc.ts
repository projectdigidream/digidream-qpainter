import type { FileRef } from './io';
import { makeCtx, type Ctx, type Rect, type RGBA, type Sym } from './paint';

export type Layer = { name: string; data: ImageData; visible: boolean; opacity: number };
type Entry =
  | { layer: number; r: Rect; before: Uint8ClampedArray; after: Uint8ClampedArray }
  | { doc: Snapshot; after: Snapshot };
type Snapshot = { w: number; h: number; layers: Layer[]; active: number };

// Sweetie 16
export const DEFAULT_PALETTE: RGBA[] = '1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57'
  .split(' ').map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(255) as RGBA);

const cloneLayer = (l: Layer): Layer => ({ ...l, data: new ImageData(l.data.data.slice(), l.data.width, l.data.height) });

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
  palette: RGBA[] = DEFAULT_PALETTE.map((c) => [...c] as RGBA);
  ramps: RGBA[][] = [];
  sel: Rect | null = null;
  settings = { wrap: false, sym: 'none' as Sym, radial: 4, ax: 0, ay: 0, lock: false, snap: 'nearest' as 'nearest' | 'dither' };
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
    this.layers = [{ name: 'Layer 1', data: new ImageData(w, h), visible: true, opacity: 1 }];
    this.settings.ax = w / 2;
    this.settings.ay = h / 2;
  }

  get layer() { return this.layers[this.active]; }

  ctx(o: Partial<Ctx> = {}): Ctx {
    const s = this.settings;
    return makeCtx(this.layer.data, {
      wrap: s.wrap, sym: s.sym, radial: s.radial, ax: s.ax, ay: s.ay,
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
      this.push({ layer: this.active, r: { ...dirty }, before: crop(this.snap, this.w, dirty), after: crop(this.layer.data.data, this.w, dirty) });
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
  private state = (): Snapshot => ({ w: this.w, h: this.h, layers: this.layers.map(cloneLayer), active: this.active });
  private apply(s: Snapshot) {
    Object.assign(this, { w: s.w, h: s.h, layers: s.layers.map(cloneLayer), active: s.active });
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
  get blank() { return this.layers.length === 1 && this.layer.data.data.every((v) => v === 0); }
  undo() { this.flush(); this.step(this.undos, this.redos, true); }
  redo() { this.flush(); this.step(this.redos, this.undos, false); }
  private step(from: Entry[], to: Entry[], back: boolean) {
    const e = from.pop();
    if (!e) return;
    if ('doc' in e) this.apply(back ? e.doc : e.after);
    else paste(this.layers[e.layer].data.data, this.w, e.r, back ? e.before : e.after);
    to.push(e);
    this.changed(true);
  }

  /** Recomposite visible layers into `comp`; `final` = stroke/edit finished (autosave etc.). */
  changed(final = false) {
    const { comp, tmp } = this;
    if (comp.width !== this.w || comp.height !== this.h) Object.assign(comp, { width: this.w, height: this.h });
    if (tmp.width !== this.w || tmp.height !== this.h) Object.assign(tmp, { width: this.w, height: this.h });
    const cg = comp.getContext('2d')!, tg = tmp.getContext('2d')!;
    cg.clearRect(0, 0, this.w, this.h);
    for (const l of this.layers) {
      if (!l.visible) continue;
      tg.putImageData(l.data, 0, 0);
      cg.globalAlpha = l.opacity;
      cg.drawImage(tmp, 0, 0);
    }
    cg.globalAlpha = 1;
    this.onChange(final);
  }

  flattened(): ImageData { return this.comp.getContext('2d')!.getImageData(0, 0, this.w, this.h); }
}
