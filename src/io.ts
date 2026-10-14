import { Capacitor, registerPlugin } from '@capacitor/core';
import { Doc, type Layer } from './doc';
import { encodeApng } from './apng';
import { SKY_DEFAULTS, type SkyKind } from './sky';
import type { RGBA } from './paint';

// ---------- files on disk ----------
// A doc can be linked to a file so Save overwrites it: a File System Access handle (desktop Chrome/Edge)
// or a content:// URI from Android's system picker (FilesPlugin.java). Both survive in IndexedDB.

export type FileRef = FileSystemFileHandle | { uri: string };
export type FileKind = 'project' | 'png' | 'gpl' | 'hex' | 'pal';
const KINDS: Record<FileKind, { mime: string; ext: string; desc: string }> = {
  project: { mime: 'application/json', ext: '.texproj.json', desc: 'Texture project' },
  png: { mime: 'image/png', ext: '.png', desc: 'PNG image' },
  gpl: { mime: 'application/octet-stream', ext: '.gpl', desc: 'GIMP palette' },
  hex: { mime: 'application/octet-stream', ext: '.hex', desc: 'Hex palette' },
  pal: { mime: 'application/octet-stream', ext: '.pal', desc: 'JASC palette' },
};

type NativeFiles = {
  create(o: { name: string; mime: string; data: string }): Promise<{ uri?: string; name?: string }>;
  write(o: { uri: string; data: string }): Promise<void>;
  open(): Promise<{ uri?: string; name?: string; data?: string }>;
  pickFolder(o: { initial?: string }): Promise<{ uri?: string }>;
  readText(o: { tree: string; path: string }): Promise<{ text?: string }>;
  writePath(o: { tree: string; path: string; mime: string; data: string }): Promise<void>;
};
const Files = registerPlugin<NativeFiles>('Files');
const native = Capacitor.isNativePlatform();
const w = globalThis as any; // File System Access API isn't in TS's DOM types yet
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
  return pickFiles(accept, false).then((f) => f[0] ?? null);
}
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((res) => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept, multiple });
    i.onchange = () => res([...(i.files ?? [])]);
    i.click();
  });
}

/**
 * Write a sky into a game module. Pick the module's folder: when it holds a module.txt, the pictures go to
 * assets/textures/ and `editModule` updates module.txt; any other folder just gets the pictures.
 * Without a folder picker (Firefox, Safari) the pictures download. Returns where they went, or null if cancelled.
 */
export async function writeToModule(files: { name: string; blob: Blob }[], editModule: (txt: string) => string): Promise<'module' | 'folder' | 'download' | null> {
  if (native) {
    const { uri } = await Files.pickFolder({ initial: localStorage.getItem('qpainter.moduleFolder') ?? undefined });
    if (!uri) return null;
    localStorage.setItem('qpainter.moduleFolder', uri);
    const { text } = await Files.readText({ tree: uri, path: 'module.txt' });
    const dir = text !== undefined ? 'assets/textures/' : '';
    for (const f of files) await Files.writePath({ tree: uri, path: dir + f.name, mime: 'image/png', data: await toB64(f.blob) });
    if (text === undefined) return 'folder';
    await Files.writePath({ tree: uri, path: 'module.txt', mime: 'text/plain', data: await toB64(new Blob([editModule(text)])) });
    return 'module';
  }
  if (w.showDirectoryPicker) {
    let dir: FileSystemDirectoryHandle;
    try { dir = await w.showDirectoryPicker({ id: 'qpainter-module', mode: 'readwrite' }); } catch (e) { if (aborted(e)) return null; throw e; }
    const mod = await dir.getFileHandle('module.txt').catch(() => null);
    const target = mod ? await (await dir.getDirectoryHandle('assets', { create: true })).getDirectoryHandle('textures', { create: true }) : dir;
    for (const f of files) await writeHandle(await target.getFileHandle(f.name, { create: true }), f.blob);
    if (!mod) return 'folder';
    await writeHandle(mod, new Blob([editModule(await (await mod.getFile()).text())], { type: 'text/plain' }));
    return 'module';
  }
  for (const f of files) download(f.blob, f.name);
  return 'download';
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
        types: [{ description: 'Images, Aseprite files and texture projects', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'], 'application/json': ['.json'], 'application/octet-stream': ['.aseprite', '.ase'] } }],
      });
      return { blob: await h.getFile(), name: h.name, ref: h };
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
  }
  const f = await pickFile('image/*,.json,.aseprite,.ase');
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

/** One frame, flattened and scaled, on a canvas. */
function frameCanvas(doc: Doc, frame: number, scale: number) {
  const src = document.createElement('canvas');
  doc.composite(frame, src);
  if (scale === 1) return src;
  const c = Object.assign(document.createElement('canvas'), { width: doc.w * scale, height: doc.h * scale });
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** All frames in one image: stacked top to bottom (the Minecraft layout) or side by side. */
export function sheetBlob(doc: Doc, scale: number, vertical: boolean): Promise<Blob> {
  const n = doc.frames, fw = doc.w * scale, fh = doc.h * scale;
  const c = Object.assign(document.createElement('canvas'), { width: vertical ? fw : fw * n, height: vertical ? fh * n : fh });
  const g = c.getContext('2d')!;
  for (let k = 0; k < n; k++) {
    const [x, y] = vertical ? [0, k * fh] : [k * fw, 0];
    // single layer at 1x: exact pixel values, including partial transparency
    if (scale === 1 && doc.layers.length === 1) g.putImageData(doc.layers[0].cels[k], x, y);
    else g.drawImage(frameCanvas(doc, k, scale), x, y);
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

/** Looping animated PNG at the doc's fps. */
export async function apngBlob(doc: Doc, scale: number): Promise<Blob> {
  const frames = Array.from({ length: doc.frames }, (_, k) =>
    scale === 1 && doc.layers.length === 1 ? doc.layers[0].cels[k] : frameCanvas(doc, k, scale).getContext('2d')!.getImageData(0, 0, doc.w * scale, doc.h * scale));
  return new Blob([(await encodeApng(frames, 1000 / doc.fps)) as BlobPart], { type: 'image/png' });
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
  frame?: number; fps?: number;
  // `data` alone = saved before animation support (one frame)
  layers: (Omit<Layer, 'data' | 'cels'> & { cels?: (ImageData | string)[]; data?: ImageData | string })[];
};

const pack = (doc: Doc, img: (d: ImageData) => ImageData | string): Saved => ({
  id: doc.id, name: doc.name,
  w: doc.w, h: doc.h, active: doc.active, palette: doc.palette, ramps: doc.ramps, settings: doc.settings,
  frame: doc.frame, fps: doc.fps,
  layers: doc.layers.map(({ name, visible, opacity, cels }) => ({ name, visible, opacity, cels: cels.map(img) })),
});
async function unpack(s: Saved): Promise<Doc> {
  const d = new Doc(s.w, s.h);
  const decode = async (v: ImageData | string) => (typeof v === 'string' ? blobToImageData(await (await fetch(v)).blob()) : v);
  const frame = s.frame ?? 0;
  d.layers = await Promise.all(s.layers.map(async ({ name, visible, opacity, cels, data }) => {
    const c = await Promise.all((cels ?? [data!]).map(decode));
    return { name, visible, opacity, cels: c, data: c[Math.min(frame, c.length - 1)] };
  }));
  Object.assign(d, { active: s.active, palette: s.palette, ramps: s.ramps, frame: Math.min(frame, d.frames - 1), fps: s.fps ?? 8 });
  if (s.id) d.id = s.id;
  if (s.name) d.name = s.name;
  Object.assign(d.settings, s.settings);
  d.settings.skyParams = { ...SKY_DEFAULTS, ...s.settings.skyParams };
  // skies saved before qPainter followed the engine's kinds (a 6:1 'strip' was a cube layout the engine doesn't read)
  const old = { cross: 'cube', equirect: 'panorama', cylinder: 'strip', grid: null } as Record<string, SkyKind | null>;
  const k = d.settings.sky as string | null;
  if (k && k in old) d.settings.sky = old[k];
  if (d.settings.sky === 'strip' && d.w === 6 * d.h) d.settings.sky = null;
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
