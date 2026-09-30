import { Capacitor, registerPlugin } from '@capacitor/core';
import { Doc, type Layer } from './doc';
import type { RGBA } from './paint';

// ---------- files on disk ----------
// A doc can be linked to a file so Save overwrites it: a File System Access handle (desktop Chrome/Edge)
// or a content:// URI from Android's system picker (FilesPlugin.java). Both survive in IndexedDB.

export type FileRef = FileSystemFileHandle | { uri: string };
export type FileKind = 'project' | 'png' | 'gpl' | 'hex';
const KINDS: Record<FileKind, { mime: string; ext: string; desc: string }> = {
  project: { mime: 'application/json', ext: '.texproj.json', desc: 'Texture project' },
  png: { mime: 'image/png', ext: '.png', desc: 'PNG image' },
  gpl: { mime: 'application/octet-stream', ext: '.gpl', desc: 'GIMP palette' },
  hex: { mime: 'application/octet-stream', ext: '.hex', desc: 'Hex palette' },
};

type NativeFiles = {
  create(o: { name: string; mime: string; data: string }): Promise<{ uri?: string; name?: string }>;
  write(o: { uri: string; data: string }): Promise<void>;
  open(): Promise<{ uri?: string; name?: string; data?: string }>;
};
const Files = registerPlugin<NativeFiles>('Files');
const native = Capacitor.isNativePlatform();
const w = window as any; // File System Access API isn't in TS's DOM types yet
const aborted = (e: unknown) => (e as Error)?.name === 'AbortError';

const toB64 = (b: Blob) => new Promise<string>((res) => {
  const r = new FileReader();
  r.onload = () => res((r.result as string).split(',')[1]);
  r.readAsDataURL(b);
});
const fromB64 = (s: string) => new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))]);
async function writeHandle(h: FileSystemFileHandle, b: Blob) {
  const out = await (h as any).createWritable();
  await out.write(b);
  await out.close();
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept });
    i.onchange = () => res(i.files?.[0] ?? null);
    i.click();
  });
}

function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * "Save as" through the system file dialog. Returns the chosen file (ref is null when the browser
 * can only download), or null if the user cancelled.
 */
export async function saveAs(blob: Blob, name: string, kind: FileKind): Promise<{ ref: FileRef | null; name: string } | null> {
  const k = KINDS[kind];
  if (!name.endsWith(k.ext)) name += k.ext;
  if (native) {
    const r = await Files.create({ name, mime: k.mime, data: await toB64(blob) });
    return r.uri ? { ref: { uri: r.uri }, name: r.name ?? name } : null;
  }
  if (w.showSaveFilePicker) {
    try {
      const h: FileSystemFileHandle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: k.desc, accept: { [k.mime]: [k.ext] } }] });
      await writeHandle(h, blob);
      return { ref: h, name: h.name };
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
  }
  download(blob, name);
  return { ref: null, name };
}

/** Overwrite a linked file. `ask` may show a browser permission prompt (needs a user gesture). */
export async function writeRef(ref: FileRef, blob: Blob, ask: boolean): Promise<boolean> {
  if ('uri' in ref) { await Files.write({ uri: ref.uri, data: await toB64(blob) }); return true; }
  const mode = { mode: 'readwrite' }, h = ref as any;
  if ((await h.queryPermission(mode)) !== 'granted' && !(ask && (await h.requestPermission(mode)) === 'granted')) return false;
  await writeHandle(ref, blob);
  return true;
}

/** Open through the system file dialog. */
export async function openAny(): Promise<{ blob: Blob; name: string; ref: FileRef | null } | null> {
  if (native) {
    const r = await Files.open();
    return r.data ? { blob: fromB64(r.data), name: r.name ?? 'file', ref: { uri: r.uri! } } : null;
  }
  if (w.showOpenFilePicker) {
    try {
      const [h]: FileSystemFileHandle[] = await w.showOpenFilePicker({
        types: [{ description: 'Images and texture projects', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'], 'application/json': ['.json'] } }],
      });
      return { blob: await h.getFile(), name: h.name, ref: h };
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
  }
  const f = await pickFile('image/*,.json');
  return f && { blob: f, name: f.name, ref: null };
}

export async function sameFile(a: FileRef | null, b: FileRef | null) {
  if (!a || !b) return false;
  if ('uri' in a || 'uri' in b) return 'uri' in a && 'uri' in b && a.uri === b.uri;
  return a.isSameEntry(b);
}

export const baseName = (n: string) => n.replace(/\.texproj\.json$|\.[^.]+$/i, '');

// ---------- images ----------

export async function blobToImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

const toCanvas = (img: ImageData) => {
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
};

/** Flattened PNG, nearest-neighbour scaled. */
export function pngBlob(doc: Doc, scale: number): Promise<Blob> {
  const c = Object.assign(document.createElement('canvas'), { width: doc.w * scale, height: doc.h * scale });
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  // single layer at 1x: write pixels directly so semi-transparent colors survive exactly
  if (scale === 1 && doc.layers.length === 1) g.putImageData(doc.layer.data, 0, 0);
  else g.drawImage(doc.comp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

function thumbnail(doc: Doc) {
  const s = Math.max(1, Math.floor(64 / Math.max(doc.w, doc.h))) || 1;
  const c = Object.assign(document.createElement('canvas'), { width: Math.min(64, doc.w * s), height: Math.min(64, doc.h * s) });
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(doc.comp, 0, 0, c.width, c.height);
  return c.toDataURL();
}

// ---------- project (de)serialization ----------
type Saved = {
  id?: string; name?: string;
  w: number; h: number; active: number; palette: RGBA[]; ramps: RGBA[][]; settings: Doc['settings'];
  layers: (Omit<Layer, 'data'> & { data: ImageData | string })[];
};

const pack = (doc: Doc, img: (d: ImageData) => ImageData | string): Saved => ({
  id: doc.id, name: doc.name,
  w: doc.w, h: doc.h, active: doc.active, palette: doc.palette, ramps: doc.ramps, settings: doc.settings,
  layers: doc.layers.map((l) => ({ ...l, data: img(l.data) })),
});
async function unpack(s: Saved): Promise<Doc> {
  const d = new Doc(s.w, s.h);
  d.layers = await Promise.all(s.layers.map(async (l) => ({
    ...l, data: typeof l.data === 'string' ? await blobToImageData(await (await fetch(l.data)).blob()) : l.data,
  })));
  Object.assign(d, { active: s.active, palette: s.palette, ramps: s.ramps });
  if (s.id) d.id = s.id;
  if (s.name) d.name = s.name;
  Object.assign(d.settings, s.settings);
  return d;
}

export const projectBlob = (doc: Doc) =>
  new Blob([JSON.stringify(pack(doc, (i) => toCanvas(i).toDataURL()))], { type: 'application/json' });
export const loadProject = async (b: Blob) => unpack(JSON.parse(await b.text()));

// ---------- library: every texture you've worked on, in IndexedDB ----------

export type Entry = {
  id: string; name: string; updated: number; thumb: string; size: string;
  file: Doc['file']; data: Saved;
};

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('textureeditor', 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv');
      if (!r.result.objectStoreNames.contains('docs')) r.result.createObjectStore('docs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function req<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const tx = (await idb()).transaction(store, mode), r = fn(tx.objectStore(store));
  return new Promise((res, rej) => {
    tx.oncomplete = () => res(r.result);
    tx.onerror = () => rej(tx.error);
  });
}

/** Store the doc in the library and mark it as the one to reopen on launch. */
export async function libPut(doc: Doc) {
  const e: Entry = { id: doc.id, name: doc.name, updated: Date.now(), thumb: thumbnail(doc), size: `${doc.w}×${doc.h}`, file: doc.file, data: pack(doc, (i) => i) };
  await req('docs', 'readwrite', (s) => s.put(e));
  await req('kv', 'readwrite', (s) => s.put(doc.id, 'currentId'));
}
export async function libList(): Promise<Entry[]> {
  const all = await req<Entry[]>('docs', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updated - a.updated);
}
export async function libLoad(e: Entry): Promise<Doc> {
  const d = await unpack(e.data);
  d.file = e.file;
  return d;
}
export const libDelete = (id: string) => req('docs', 'readwrite', (s) => s.delete(id));

/** The doc that was open last time. */
export async function restore(): Promise<Doc | null> {
  try {
    const id = await req<string | undefined>('kv', 'readonly', (s) => s.get('currentId'));
    const e = id && (await req<Entry | undefined>('docs', 'readonly', (s) => s.get(id)));
    if (e) return libLoad(e);
    // autosave from before the library existed
    const old = await req<Saved | undefined>('kv', 'readonly', (s) => s.get('current'));
    return old ? unpack(old) : null;
  } catch {
    return null;
  }
}
