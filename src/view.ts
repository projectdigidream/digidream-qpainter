import type { Doc } from './doc';
import type { P, Tool } from './tools';
import { opts } from './tools';

export const viewOpts = { grid: true, tileGrid: 0, tiled: true };

export class View {
  zoom = 8;
  ox = 0; // screen position of image origin (css px)
  oy = 0;
  private g: CanvasRenderingContext2D;
  private ptrs = new Map<number, { x: number; y: number }>();
  private stroking = false;
  private gesture: { d: number; mx: number; my: number } | null = null;
  private panLast: { x: number; y: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private queued = false;
  space = false;
  private fitted = false;

  constructor(private cv: HTMLCanvasElement, private doc: () => Doc, private tool: () => Tool, private onSymCenter: (x: number, y: number) => void) {
    this.g = cv.getContext('2d')!;
    // fit once the canvas has a real size (at startup the layout may not be ready yet)
    new ResizeObserver(() => (this.fitted ? this.render() : this.fit())).observe(cv);
    cv.addEventListener('pointerdown', (e) => this.down(e));
    cv.addEventListener('pointermove', (e) => this.move(e));
    cv.addEventListener('pointerup', (e) => this.up(e));
    cv.addEventListener('pointercancel', (e) => this.up(e));
    cv.addEventListener('pointerleave', () => { this.hover = null; this.render(); });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
    }, { passive: false });
  }

  fit() {
    const d = this.doc(), r = this.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.fitted = true;
    this.zoom = Math.max(0.1, Math.min(r.width / d.w, r.height / d.h) * 0.8);
    if (this.zoom > 1) this.zoom = Math.floor(this.zoom);
    this.ox = (r.width - d.w * this.zoom) / 2;
    this.oy = (r.height - d.h * this.zoom) / 2;
    this.render();
  }
  zoomAt(sx: number, sy: number, f: number) {
    const z = Math.min(128, Math.max(0.1, this.zoom * f));
    this.ox = sx - ((sx - this.ox) * z) / this.zoom;
    this.oy = sy - ((sy - this.oy) * z) / this.zoom;
    this.zoom = z;
    this.render();
  }

  private toP(e: PointerEvent): P {
    return {
      x: (e.offsetX - this.ox) / this.zoom, y: (e.offsetY - this.oy) / this.zoom,
      pressure: e.pointerType === 'pen' ? e.pressure || 0.01 : 1,
      shift: e.shiftKey, alt: e.altKey, right: e.button === 2 || (e.buttons & 2) !== 0,
    };
  }

  private down(e: PointerEvent) {
    this.cv.setPointerCapture(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.ptrs.size === 2) {
      // second finger: abort the stroke, start pinch/pan
      if (this.stroking) { this.doc().cancel(); this.stroking = false; }
      const [a, b] = [...this.ptrs.values()];
      this.gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (e.button === 1 || this.space) { this.panLast = { x: e.offsetX, y: e.offsetY }; return; }
    const p = this.toP(e);
    if (e.ctrlKey || e.metaKey) { this.onSymCenter(Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2); return; }
    this.stroking = true;
    this.tool().down(p);
  }

  private move(e: PointerEvent) {
    const p = this.toP(e);
    this.hover = { x: p.x, y: p.y };
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.gesture && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.ox += mx - this.gesture.mx;
      this.oy += my - this.gesture.my;
      this.zoomAt(mx, my, d / (this.gesture.d || 1));
      this.gesture = { d, mx, my };
      return;
    }
    if (this.panLast) {
      this.ox += e.offsetX - this.panLast.x;
      this.oy += e.offsetY - this.panLast.y;
      this.panLast = { x: e.offsetX, y: e.offsetY };
      return this.render();
    }
    if (this.stroking) for (const ce of e.getCoalescedEvents?.() ?? [e]) this.tool().move(this.toP(ce));
    else this.render();
  }

  private up(e: PointerEvent) {
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.gesture = null;
    this.panLast = null;
    if (this.stroking) { this.stroking = false; this.tool().up(this.toP(e)); }
  }

  render() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  private draw() {
    const { cv, g, zoom: z } = this, d = this.doc();
    const dpr = devicePixelRatio, r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = getComputedStyle(cv).getPropertyValue('--stage').trim() || '#222';
    g.fillRect(0, 0, r.width, r.height);
    const W = d.w * z, H = d.h * z;
    const tiles = d.settings.wrap && viewOpts.tiled ? [-1, 0, 1] : [0];
    for (const ty of tiles)
      for (const tx of tiles) {
        const x = this.ox + tx * W, y = this.oy + ty * H;
        g.fillStyle = checker(g);
        g.save(); g.translate(x, y); g.fillRect(0, 0, W, H); g.restore();
        g.drawImage(d.comp, x, y, W, H);
      }
    if (tiles.length > 1) {
      // dim the neighbour tiles so the real one stands out
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(this.ox - W, this.oy - H, W * 3, H);
      g.fillRect(this.ox - W, this.oy + H, W * 3, H);
      g.fillRect(this.ox - W, this.oy, W, H);
      g.fillRect(this.ox + W, this.oy, W, H);
    }
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    g.strokeRect(this.ox - 0.5, this.oy - 0.5, W + 1, H + 1);

    const gridLines = (step: number, style: string) => {
      g.strokeStyle = style;
      g.beginPath();
      for (let x = step; x < d.w; x += step) { g.moveTo(Math.round(this.ox + x * z) + 0.5, this.oy); g.lineTo(Math.round(this.ox + x * z) + 0.5, this.oy + H); }
      for (let y = step; y < d.h; y += step) { g.moveTo(this.ox, Math.round(this.oy + y * z) + 0.5); g.lineTo(this.ox + W, Math.round(this.oy + y * z) + 0.5); }
      g.stroke();
    };
    if (viewOpts.grid && z >= 8) gridLines(1, 'rgba(128,128,128,0.25)');
    if (viewOpts.tileGrid > 0) gridLines(viewOpts.tileGrid, 'rgba(80,160,255,0.7)');

    const s = d.settings;
    if (s.sym !== 'none') {
      const cx = this.ox + s.ax * z, cy = this.oy + s.ay * z;
      g.strokeStyle = 'rgba(255,80,160,0.8)';
      g.setLineDash([4, 4]);
      g.beginPath();
      if (s.sym === 'x' || s.sym === 'xy') { g.moveTo(cx, this.oy); g.lineTo(cx, this.oy + H); }
      if (s.sym === 'y' || s.sym === 'xy') { g.moveTo(this.ox, cy); g.lineTo(this.ox + W, cy); }
      if (s.sym === 'diag') { const m = Math.max(W, H); g.moveTo(cx - m, cy - m); g.lineTo(cx + m, cy + m); }
      if (s.sym === 'radial') for (let k = 0; k < s.radial; k++) {
        const t = (2 * Math.PI * k) / s.radial;
        g.moveTo(cx, cy); g.lineTo(cx + Math.cos(t) * Math.max(W, H), cy + Math.sin(t) * Math.max(W, H));
      }
      g.stroke();
      g.setLineDash([]);
    }
    if (d.sel) {
      g.setLineDash([4, 4]);
      g.strokeStyle = '#fff';
      g.strokeRect(this.ox + d.sel.x * z + 0.5, this.oy + d.sel.y * z + 0.5, d.sel.w * z, d.sel.h * z);
      g.strokeStyle = '#000';
      g.lineDashOffset = 4;
      g.strokeRect(this.ox + d.sel.x * z + 0.5, this.oy + d.sel.y * z + 0.5, d.sel.w * z, d.sel.h * z);
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }
    if (this.hover) {
      const sz = opts.size * z, hx = this.ox + (opts.size % 2 ? Math.floor(this.hover.x) + 0.5 : Math.round(this.hover.x)) * z;
      const hy = this.oy + (opts.size % 2 ? Math.floor(this.hover.y) + 0.5 : Math.round(this.hover.y)) * z;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      if (opts.size <= 1) g.strokeRect(hx - z / 2, hy - z / 2, z, z);
      else { g.beginPath(); g.arc(hx, hy, sz / 2, 0, Math.PI * 2); g.stroke(); }
    }
  }
}

let pat: CanvasPattern | null = null;
function checker(g: CanvasRenderingContext2D) {
  if (pat) return pat;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = '#bbb'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#888'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return (pat = g.createPattern(c, 'repeat')!);
}
