// qPainter inside another app.
//
// Opened with `?host=<name>` (the Digidream suite passes `host=suite`), the
// texture belongs to the app around qPainter, not to qPainter: it is handed
// in and taken back. So qPainter skips what it does for a texture of its own
// -- restoring the last one from its library, autosaving into the library,
// registering its service worker -- hides its file buttons (New, Open,
// Recent, Save, Save as), and offers `window.qpainterEmbed` to the host:
//
//   load(bytes, name)   a project (.texproj.json) or a PNG; empty = a NEW texture: the
//                       New choices (size, W×H, skybox) in a dialog of its own, since
//                       the New menu is hidden and Electron has no prompt()
//   bytes()             the texture as a project, the way Save writes one
//   onChange(fn)        called after every finished edit; returns an unsubscribe
//
// The host speaks its own protocol to it (in the suite, a small shim that
// loads before this page's script). Nothing here knows any host's protocol.

import { Doc } from './doc';
import { blobToImageData, loadProject, projectBlob } from './io';
import { SKY_DEFAULTS, skySize, type SkyKind } from './sky';

export interface EmbedHooks {
  current(): Doc;
  setDoc(d: Doc): void;
}
export interface Embed {
  /** Tell the host the texture changed (called where qPainter would autosave). */
  changed(): void;
}

export function startEmbed(h: EmbedHooks): Embed | null {
  const host = new URLSearchParams(location.search).get('host');
  if (!host) return null;
  const css = document.createElement('style');
  css.textContent = '#new,#open,#recentbtn,#save,#saveas{display:none!important}';
  document.head.appendChild(css);
  const listeners = new Set<() => void>();
  const api = {
    host,
    async load(bytes: Uint8Array, name: string) {
      const cur = h.current();
      let d: Doc;
      if (!bytes.length) d = await chooseNew(cur);
      else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        const img = await blobToImageData(new Blob([bytes as BlobPart], { type: 'image/png' }));
        d = new Doc(img.width, img.height);
        d.layers[0].data = d.layers[0].cels[0] = img;
        Object.assign(d, { palette: cur.palette, ramps: cur.ramps });
        Object.assign(d.settings, { ...cur.settings, ax: img.width / 2, ay: img.height / 2, sky: null, skyParams: { ...SKY_DEFAULTS } });
      } else d = await loadProject(new Blob([bytes as BlobPart], { type: 'application/json' }));
      d.name = name;
      d.file = null;
      h.setDoc(d);
    },
    async bytes(): Promise<Uint8Array> {
      const d = h.current();
      d.flush();
      return new Uint8Array(await projectBlob(d).arrayBuffer());
    },
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  (window as unknown as { qpainterEmbed: typeof api }).qpainterEmbed = api;
  window.dispatchEvent(new Event('qpainter-embed'));
  return { changed() { for (const f of listeners) f(); } };
}

/**
 * A new texture, chosen as the New menu chooses one: a square size, any W×H,
 * or a DoomNet skybox (strip, panorama, cube) at a size of its own. A dialog
 * rather than the menu's prompt()s: a host may hide the menu, and Electron
 * does not implement prompt(). Same rules: 1..4096, even sizes for skies.
 */
function chooseNew(cur: Doc): Promise<Doc> {
  const SIZES = [16, 32, 64, 128, 256, 512, 1024];
  const SKY: Record<SkyKind, [string, number]> = {
    strip: ['Strip — DOOM sky. Width (DOOM\'s are 256 × 128)', 256],
    panorama: ['Panorama (2:1). Width (2048 suits phones)', 1024],
    cube: ['Cube (six faces). Face size (512 suits phones)', 128],
  };
  const dlg = document.createElement('dialog');
  dlg.id = 'embed-new';
  dlg.style.cssText = 'border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);padding:16px;width:min(380px,92vw)';
  dlg.innerHTML = `
    <form method="dialog" style="display:flex;flex-direction:column;gap:10px;margin:0">
      <b>New texture</b>
      <label>Kind <select name="kind">
        <option value="tex">Texture</option>
        <option value="strip">Skybox: strip (DOOM sky)</option>
        <option value="panorama">Skybox: panorama (2:1)</option>
        <option value="cube">Skybox: cube (six faces)</option>
      </select></label>
      <label data-for="tex">Size <select name="size">
        ${SIZES.map((n) => `<option value="${n}"${n === 64 ? ' selected' : ''}>${n} × ${n}</option>`).join('')}
        <option value="custom">W × H…</option>
      </select></label>
      <div data-for="custom" style="display:flex;gap:6px;align-items:center">
        <input name="w" type="number" min="1" max="4096" value="64" style="width:6em"> ×
        <input name="h" type="number" min="1" max="4096" value="32" style="width:6em">
      </div>
      <label data-for="sky"><span data-sky-label></span><br><input name="n" type="number" min="2" max="4096" step="2" style="width:8em"></label>
      <span data-why style="color:#ff8a8a;min-height:1.2em"></span>
      <div style="display:flex;justify-content:flex-end"><button value="ok" class="acc">Create</button></div>
    </form>`;
  document.body.appendChild(dlg);
  const f = dlg.querySelector('form')!;
  const el = <T extends HTMLElement>(q: string) => dlg.querySelector(q) as T;
  const sync = () => {
    const kind = (f.kind as HTMLSelectElement).value;
    el<HTMLElement>('[data-for=tex]').hidden = kind !== 'tex';
    el<HTMLElement>('[data-for=custom]').style.display = kind === 'tex' && (f.size as HTMLSelectElement).value === 'custom' ? 'flex' : 'none';
    el<HTMLElement>('[data-for=sky]').hidden = kind === 'tex';
    if (kind !== 'tex') {
      const [label, n] = SKY[kind as SkyKind];
      el<HTMLElement>('[data-sky-label]').textContent = label;
      if (!(f.n as HTMLInputElement).dataset.kind || (f.n as HTMLInputElement).dataset.kind !== kind) { (f.n as HTMLInputElement).value = String(n); (f.n as HTMLInputElement).dataset.kind = kind; }
    }
  };
  f.addEventListener('change', sync);
  sync();
  return new Promise((resolve) => {
    // Not dismissable: the host is waiting for a texture.
    dlg.addEventListener('cancel', (e) => e.preventDefault());
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = (f.kind as HTMLSelectElement).value;
      let w: number, h: number, sky: SkyKind | null = null;
      if (kind === 'tex') {
        const v = (f.size as HTMLSelectElement).value;
        [w, h] = v === 'custom' ? [Math.round(+(f.w as HTMLInputElement).value), Math.round(+(f.h as HTMLInputElement).value)] : [+v, +v];
      } else {
        sky = kind as SkyKind;
        const n = Math.round(+(f.n as HTMLInputElement).value);
        if (!(n > 0) || n % 2) { el<HTMLElement>('[data-why]').textContent = 'Use an even size.'; return; }
        [w, h] = skySize(sky, n);
      }
      if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) { el<HTMLElement>('[data-why]').textContent = 'Sizes go from 1 to 4096.'; return; }
      const d = new Doc(w, h);
      Object.assign(d, { palette: cur.palette, ramps: cur.ramps });
      Object.assign(d.settings, { ...cur.settings, ax: w / 2, ay: h / 2, sky, wrap: sky ? false : cur.settings.wrap, skyParams: { ...SKY_DEFAULTS } });
      dlg.close();
      dlg.remove();
      resolve(d);
    });
    dlg.showModal();
  });
}
