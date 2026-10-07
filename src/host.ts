// qPainter inside another app.
//
// Opened with `?host=<name>` (the Digidream suite passes `host=suite`), the
// texture belongs to the app around qPainter, not to qPainter: it is handed
// in and taken back. So qPainter skips what it does for a texture of its own
// -- restoring the last one from its library, autosaving into the library,
// registering its service worker -- hides its file buttons (New, Open,
// Recent, Save, Save as), and offers `window.qpainterEmbed` to the host:
//
//   load(bytes, name)   a project (.texproj.json) or a PNG; empty = the blank texture as it is
//   bytes()             the texture as a project, the way Save writes one
//   onChange(fn)        called after every finished edit; returns an unsubscribe
//
// The host speaks its own protocol to it (in the suite, a small shim that
// loads before this page's script). Nothing here knows any host's protocol.

import { Doc } from './doc';
import { blobToImageData, loadProject, projectBlob } from './io';
import { SKY_DEFAULTS } from './sky';

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
      if (!bytes.length) d = cur;
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
