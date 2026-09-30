import './style.css';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Doc } from './doc';
import { baseName, blobToImageData, pickFile, libDelete, libList, libLoad, libPut, loadProject, openAny, pngBlob, projectBlob, restore, sameFile, saveAs, writeRef } from './io';
import { PATTERNS, blend, getPx, mod, offset, type Sym } from './paint';
import { hex, renderPalette, updateStats } from './palette';
import { MESHES, createPreview, previewOpts, type PaintEvent } from './preview3d';
import { cancelFloat, clearSel, commitFloat, copySel, makeTools, opts, pasteClip, pattern, setClipboard, transformSel, type P, type Tool } from './tools';
import { View, viewOpts } from './view';

const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLInputElement>(s: string) => [...document.querySelectorAll<T>(s)];

let doc = new Doc(32, 32);
let tools = makeTools(doc, () => refreshPalette());
let current = 'pencil';
let altHeld = false;

const TOOLS: [string, string, string, string][] = [
  // id, icon, key, title
  ['pencil', '✏️', 'p', 'Pencil'], ['brush', '🖌️', 'b', 'Soft brush'], ['eraser', '🧽', 'e', 'Eraser'],
  ['dither', '▦', 'd', 'Dither brush'], ['shade', '◐', 'h', 'Ramp shade brush'], ['noise', '⁘', 'n', 'Noise / scatter'],
  ['replace', '⇄', 'r', 'Replace color brush'], ['smooth', '≈', 'a', 'Smooth / AA helper'],
  ['line', '╱', 'l', 'Line (Shift = 45°)'], ['rect', '▭', 'u', 'Rectangle (Shift = square)'], ['ellipse', '◯', 'c', 'Ellipse (Shift = circle)'],
  ['fill', '🪣', 'g', 'Fill'], ['gradient', '▤', 'j', 'Dithered gradient'], ['picker', '💧', 'i', 'Eyedropper (or hold Alt)'],
  ['select', '⬚', 'm', 'Select'], ['move', '✥', 'v', 'Move selection / offset layer (O)'],
];

const view = new View($<HTMLCanvasElement>('#view'), () => doc,
  (): Tool => (altHeld && current !== 'move' ? tools.picker : tools[current]),
  (x, y) => { Object.assign(doc.settings, { ax: x, ay: y }); view.render(); save(); });
const preview = createPreview($('#p3d'), doc.comp, paint3d);

// Painting on the 3D model: UV hits become ordinary tool events in image space.
let last3d: P | null = null;
function paint3d(kind: PaintEvent, uv: { x: number; y: number } | null, e: PointerEvent) {
  const tool = tools[current];
  if (kind === 'cancel') { if (last3d) doc.cancel(); last3d = null; return; }
  if (kind === 'up') { if (last3d) tool.up(last3d); last3d = null; return; }
  const p: P = { x: uv!.x * doc.w, y: uv!.y * doc.h, pressure: e.pointerType === 'pen' ? e.pressure || 0.01 : 1, shift: e.shiftKey, alt: e.altKey, right: false };
  if (kind === 'down' || !last3d) tool.down(p);
  // a big jump means the ray crossed a UV seam: don't draw a line across the texture
  else if (Math.hypot(p.x - last3d.x, p.y - last3d.y) > Math.max(doc.w, doc.h) / 4) { tool.up(last3d); tool.down(p); }
  else tool.move(p);
  last3d = p;
}

// ---------- change propagation ----------
// Every change is autosaved into the library (IndexedDB); Save writes to a real file.
let saveTimer = 0, booted = false; // no autosave until the last texture is restored, or a blank one would be stored
const save = () => { if (!booted) return; doc.unsaved = true; showName(); clearTimeout(saveTimer); saveTimer = window.setTimeout(() => libPut(doc), 800); };
function hook(d: Doc) {
  d.onChange = (final) => {
    view.render();
    preview.update();
    if (final) { renderLayers(); updateStats($('#pal'), d); save(); }
  };
}
function showName() {
  $('#docname').textContent = doc.name + (doc.file && doc.unsaved ? ' •' : '');
  $('#docname').title = doc.file ? `Linked to a ${doc.file.kind === 'png' ? 'PNG' : 'project'} file${doc.unsaved ? ' (unsaved changes)' : ''}. Click to rename.` : 'Not saved to a file yet. Click to rename.';
}

const fileBlob = (kind: 'project' | 'png') => (kind === 'png' ? pngBlob(doc, 1) : projectBlob(doc));
/** Save to the linked file; with `as` (or no link) ask where. */
async function saveDoc(as?: 'project' | 'png') {
  doc.flush();
  try {
    if (!as && doc.file && (await writeRef(doc.file.ref, await fileBlob(doc.file.kind), true))) return saved();
    const kind = as ?? doc.file?.kind ?? 'project';
    const r = await saveAs(await fileBlob(kind), doc.name, kind);
    if (!r) return; // cancelled
    doc.name = baseName(r.name);
    doc.file = r.ref && { ref: r.ref, kind };
    saved();
  } catch (e) {
    alert(`Couldn't save: ${(e as Error).message}`);
  }
}
function saved() {
  doc.unsaved = false;
  showName();
  clearTimeout(saveTimer);
  libPut(doc);
}
/** Before switching away: store the doc in the library and write its linked file if it changed. */
async function leaveDoc() {
  doc.flush();
  clearTimeout(saveTimer);
  if (!doc.file && doc.blank) return libDelete(doc.id); // empty and never saved: don't clutter Recent
  await libPut(doc);
  // no permission prompt here; if the browser forgot access, the library copy still has everything
  if (doc.file && doc.unsaved) await writeRef(doc.file.ref, await fileBlob(doc.file.kind), false).catch(() => false);
}
async function switchTo(d: Doc) {
  if (d !== doc) await leaveDoc();
  setDoc(d);
  await libPut(doc);
}

function setDoc(d: Doc) {
  doc.flush();
  d.comp = doc.comp; // keep the canvas the 3D preview is bound to
  doc = d;
  tools = makeTools(doc, () => refreshPalette());
  hook(doc);
  syncHeader();
  refreshPalette();
  doc.changed(true);
  doc.unsaved = false;
  showName();
  view.fit();
}

// ---------- tools + options ----------
const nav = $('#tools');
for (const [id, icon, key, title] of TOOLS) {
  const b = document.createElement('button');
  Object.assign(b, { textContent: icon, title: `${title} (${key.toUpperCase()})` });
  b.dataset.tool = id;
  b.onclick = () => setTool(id);
  nav.appendChild(b);
}
const sizes: Record<string, number> = { brush: 8, eraser: 4 };
function setTool(id: string) {
  if (id !== 'move' && id !== 'select') commitFloat(doc);
  sizes[current] = opts.size;
  opts.size = sizes[id] ?? 1;
  syncOpts();
  current = id;
  $$('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === id));
  $$('#opts [data-for]').forEach((el) => (el.style.display = el.dataset.for!.split(' ').includes(id) ? '' : 'none'));
}

type Opts = typeof opts;
function setOpt<K extends keyof Opts>(k: K, v: Opts[K]) { opts[k] = v; syncOpts(); }
function syncOpts() {
  for (const el of $$('[data-opt]')) {
    const v = opts[el.dataset.opt as keyof Opts];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  for (const o of $$<HTMLOutputElement>('[data-out]')) o.value = String(opts[o.dataset.out as keyof Opts]);
  drawPattern();
  view.render();
}
for (const el of $$('[data-opt]')) {
  el.addEventListener('input', () => {
    const k = el.dataset.opt as keyof Opts;
    (opts as any)[k] = el.type === 'checkbox' ? el.checked : typeof opts[k] === 'number' ? +el.value : el.value;
    syncOpts();
  });
}

// pattern preview / custom pattern editor
const patCv = $<HTMLCanvasElement>('#pat');
function drawPattern() {
  const p = pattern(), g = patCv.getContext('2d')!;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      g.fillStyle = hex(p.t[(y % p.n) * p.n + (x % p.n)] < (opts.pattern === 'checker' || opts.pattern === 'custom' ? 0.5 : opts.density) ? opts.primary : opts.secondary);
      g.fillRect(x, y, 1, 1);
    }
  $('#patwarn').textContent = doc.settings.wrap && (doc.w % p.n || doc.h % p.n) ? `⚠ ${p.n}px pattern won't tile at ${doc.w}×${doc.h}` : '';
}
patCv.onclick = (e) => {
  if (opts.pattern !== 'custom') return setOpt('pattern', 'custom');
  const r = patCv.getBoundingClientRect(), x = Math.floor(((e.clientX - r.left) / r.width) * 8), y = Math.floor(((e.clientY - r.top) / r.height) * 8);
  const t = PATTERNS.custom.t, i = mod(y - opts.patY, 8) * 8 + mod(x - opts.patX, 8); // preview is shown shifted
  t[i] = t[i] ? 0 : 1;
  drawPattern();
};

for (const b of $$<HTMLButtonElement>('[data-act]')) {
  b.onclick = () => selAction(b.dataset.act!);
}
function selAction(a: string) {
  if (a === 'copy') copySel(doc);
  else if (a === 'cut') { copySel(doc); clearSel(doc); }
  else if (a === 'paste') { pasteClip(doc); setTool('move'); }
  else if (a === 'clear') clearSel(doc);
  else if (a === 'h' || a === 'v' || a === 'rot') transformSel(doc, a);
  else if (a === 'all') { doc.sel = { x: 0, y: 0, w: doc.w, h: doc.h }; view.render(); }
  else if (a === 'none') { commitFloat(doc); doc.sel = null; view.render(); }
}

// ---------- palette ----------
function refreshPalette() {
  renderPalette($('#pal'), doc, refreshPalette);
  drawPattern();
  save();
}

// ---------- layers ----------
function renderLayers() {
  const el = $('#layers');
  el.innerHTML = doc.layers.map((l, i) => `
    <div class="layer ${i === doc.active ? 'on' : ''}" data-i="${i}">
      <input type="checkbox" ${l.visible ? 'checked' : ''} title="Visible">
      <span>${l.name.replace(/</g, '&lt;')}</span>
      ${i === doc.active ? `<input type="range" min="0" max="1" step="0.05" value="${l.opacity}" title="Opacity">` : ''}
    </div>`).reverse().join('') + `
    <div class="row wrap">
      <button data-l="add" title="New layer">+</button><button data-l="dup" title="Duplicate">⧉</button>
      <button data-l="del" title="Delete">−</button><button data-l="up" title="Move up">↑</button>
      <button data-l="down" title="Move down">↓</button><button data-l="merge" title="Merge down">⤓</button>
    </div>`;
  el.querySelectorAll<HTMLElement>('.layer').forEach((row) => {
    const i = +row.dataset.i!, l = doc.layers[i];
    row.onclick = () => { if (doc.active !== i) { doc.flush(); doc.active = i; renderLayers(); } };
    row.ondblclick = () => { const n = prompt('Layer name', l.name); if (n) { l.name = n; renderLayers(); save(); } };
    const [vis, op] = row.querySelectorAll('input');
    vis.onclick = (e) => e.stopPropagation();
    vis.onchange = () => { l.visible = vis.checked; doc.changed(true); };
    if (op) op.oninput = () => { l.opacity = +op.value; doc.changed(); };
    if (op) op.onchange = () => doc.changed(true);
  });
  el.querySelectorAll<HTMLButtonElement>('[data-l]').forEach((b) => (b.onclick = () => layerOp(b.dataset.l!)));
}
function layerOp(op: string) {
  const a = doc.active, L = doc.layers;
  if ((op === 'del' || op === 'merge') && L.length < 2) return;
  if ((op === 'up' && a === L.length - 1) || ((op === 'down' || op === 'merge') && a === 0)) return;
  doc.structural(() => {
    if (op === 'add') { L.splice(a + 1, 0, { name: `Layer ${L.length + 1}`, data: new ImageData(doc.w, doc.h), visible: true, opacity: 1 }); doc.active++; }
    if (op === 'dup') { L.splice(a + 1, 0, { ...L[a], name: L[a].name + ' copy', data: new ImageData(L[a].data.data.slice(), doc.w, doc.h) }); doc.active++; }
    if (op === 'del') { L.splice(a, 1); doc.active = Math.max(0, a - 1); }
    if (op === 'up' || op === 'down') { const b = op === 'up' ? a + 1 : a - 1; [L[a], L[b]] = [L[b], L[a]]; doc.active = b; }
    if (op === 'merge') {
      const top = L[a], bot = L[a - 1];
      for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) bot.data.data.set(blend(getPx(bot.data, x, y), getPx(top.data, x, y), top.visible ? top.opacity : 0), (y * doc.w + x) * 4);
      L.splice(a, 1);
      doc.active = a - 1;
    }
  });
}

// ---------- header ----------
function syncHeader() {
  const s = doc.settings;
  $('#wrap').checked = s.wrap;
  $('#lock').checked = s.lock;
  $<HTMLSelectElement>('#sym').value = s.sym;
  $('#radial').value = String(s.radial);
  $('#radial').style.display = s.sym === 'radial' ? '' : 'none';
  $<HTMLSelectElement>('#snap').value = s.snap;
}
const setting = () => {
  Object.assign(doc.settings, {
    wrap: $('#wrap').checked, lock: $('#lock').checked, sym: $<HTMLSelectElement>('#sym').value as Sym,
    radial: Math.max(2, +$('#radial').value || 4), snap: $<HTMLSelectElement>('#snap').value,
  });
  syncHeader();
  drawPattern();
  view.render();
  save();
};
for (const id of ['#wrap', '#lock', '#sym', '#radial', '#snap']) $(id).addEventListener('change', setting);
$('#symc').onclick = () => { Object.assign(doc.settings, { ax: doc.w / 2, ay: doc.h / 2 }); view.render(); save(); };
for (const el of $$('[data-view]')) {
  const k = el.dataset.view as keyof typeof viewOpts;
  el.addEventListener('change', () => { (viewOpts as any)[k] = el.type === 'checkbox' ? el.checked : +el.value; view.render(); });
}

$<HTMLSelectElement>('#new').onchange = () => {
  const v = $<HTMLSelectElement>('#new').value;
  $<HTMLSelectElement>('#new').value = '';
  let w = +v, h = +v;
  if (v === 'custom') [w, h] = (prompt('Size (W×H)', '64x32') ?? '').split(/[x×*, ]+/).map(Number);
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) return;
  const d = new Doc(w, h);
  Object.assign(d, { palette: doc.palette, ramps: doc.ramps }); // keep palette between textures
  Object.assign(d.settings, { ...doc.settings, ax: w / 2, ay: h / 2 });
  d.name = `Untitled ${w}×${h}`;
  switchTo(d);
};
$('#open').onclick = openFile;
async function openFile() {
  try {
    const f = await openAny();
    if (!f) return;
    let d: Doc;
    if (/\.json$/i.test(f.name)) d = await loadProject(f.blob);
    else {
      const img = await blobToImageData(f.blob);
      d = new Doc(img.width, img.height);
      d.layers[0].data = img;
      Object.assign(d, { palette: doc.palette, ramps: doc.ramps });
      Object.assign(d.settings, { ...doc.settings, ax: img.width / 2, ay: img.height / 2 });
    }
    d.name = baseName(f.name);
    d.file = f.ref && { ref: f.ref, kind: /\.json$/i.test(f.name) ? 'project' : 'png' };
    // reopening a file that's already in Recent replaces that entry instead of adding a duplicate
    for (const e of await libList()) if (await sameFile(e.file?.ref ?? null, f.ref)) { d.id = e.id; break; }
    await switchTo(d);
  } catch (e) {
    alert(`Couldn't open: ${(e as Error).message}`);
  }
}
$('#save').onclick = () => saveDoc();
$<HTMLSelectElement>('#saveas').onchange = () => {
  const k = $<HTMLSelectElement>('#saveas').value as 'project' | 'png' | '';
  $<HTMLSelectElement>('#saveas').value = '';
  if (k) saveDoc(k);
};
$('#docname').onclick = () => {
  const n = prompt('Texture name', doc.name)?.trim();
  if (n) { doc.name = n; save(); }
};
$<HTMLSelectElement>('#export').onchange = async () => {
  const s = +$<HTMLSelectElement>('#export').value;
  $<HTMLSelectElement>('#export').value = '';
  if (!s) return;
  try { await saveAs(await pngBlob(doc, s), `${doc.name}${s > 1 ? `@${s}x` : ''}`, 'png'); } catch (e) { alert(`Couldn't export: ${(e as Error).message}`); }
};

// ---------- recent textures ----------
const recent = $<HTMLDialogElement>('#recent');
$('#recentbtn').onclick = async () => { await renderRecent(); recent.showModal(); };
$('#recentclose').onclick = () => recent.close();
recent.onclick = (e) => { if (e.target === recent) recent.close(); }; // click on the backdrop
async function renderRecent() {
  await libPut(doc); // so the current one shows up to date
  const list = await libList(), el = $('#recentlist');
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  el.innerHTML = list.map((e) => `
    <div class="rec ${e.id === doc.id ? 'on' : ''}" data-id="${e.id}">
      <img src="${e.thumb}" alt="">
      <div><b>${esc(e.name)}</b><small>${e.size} · ${new Date(e.updated).toLocaleString()}${e.file ? ` · ${e.file.kind === 'png' ? 'PNG' : 'project'} file` : ' · not saved to a file'}</small></div>
      ${e.id === doc.id ? '<small>open</small>' : `<button data-del="${e.id}" title="Remove from list (files on disk are kept)">×</button>`}
    </div>`).join('') || '<p class="empty">Nothing here yet.</p>';
  el.querySelectorAll<HTMLElement>('.rec').forEach((row) => (row.onclick = async (ev) => {
    const del = (ev.target as HTMLElement).dataset.del, e = list.find((x) => x.id === row.dataset.id)!;
    if (del) { await libDelete(del); return renderRecent(); }
    recent.close();
    if (e.id !== doc.id) await switchTo(await libLoad(e));
  }));
}
$('#undo').onclick = () => doc.undo();
$('#redo').onclick = () => doc.redo();
$('#fit').onclick = () => view.fit();
$('#panel').onclick = togglePanel;
$('#closeside').onclick = closePanel;

// ---------- side panel (on phones it's an overlay) ----------
// On phones, opening pushes a history entry so the Android back button/gesture closes it
// (in the APK, Capacitor maps the back button to WebView history.back()).
const phone = matchMedia('(max-width: 800px)');
function togglePanel() {
  const on = document.body.classList.toggle('alt');
  if (!phone.matches) return;
  if (on) history.pushState({ panel: true }, '');
  else if (history.state?.panel) history.back();
}
function closePanel() { if (phone.matches && document.body.classList.contains('alt')) togglePanel(); }
addEventListener('popstate', () => { if (phone.matches) document.body.classList.remove('alt'); });
// Android app: back steps through that history (closing the panel), and leaves the app when there's none.
if (Capacitor.isNativePlatform())
  App.addListener('backButton', ({ canGoBack }) => (recent.open ? recent.close() : canGoBack ? history.back() : App.exitApp()));
// tap outside closes it (without painting)
$('#stage').addEventListener('pointerdown', (e) => {
  if (phone.matches && document.body.classList.contains('alt')) { e.stopPropagation(); closePanel(); }
}, true);
// swipe right closes it; ignore drags that start on sliders, swatches or the 3D view
let swipe: { x: number; y: number } | null = null;
$('#side').addEventListener('pointerdown', (e) => {
  swipe = e.pointerType === 'touch' && !(e.target as HTMLElement).closest('input, canvas, .swatches') ? { x: e.clientX, y: e.clientY } : null;
});
$('#side').addEventListener('pointerup', (e) => {
  if (swipe && e.clientX - swipe.x > 60 && Math.abs(e.clientX - swipe.x) > 2 * Math.abs(e.clientY - swipe.y)) closePanel();
  swipe = null;
});
$('#offhalf').onclick = () => doc.edit((img) => img.data.set(offset(img, doc.w >> 1, doc.h >> 1).data));

// ---------- 3D preview controls ----------
const meshSel = $<HTMLSelectElement>('[data-p3=mesh]');
meshSel.innerHTML = MESHES.map((m) => `<option>${m}</option>`).join('');
$('#model').onclick = async () => {
  const f = await pickFile('.glb,.gltf,.obj');
  if (!f) return;
  try {
    await preview.load(f);
    if (!meshSel.querySelector('[value=custom]')) meshSel.add(new Option('custom', 'custom'));
    meshSel.value = 'custom';
  } catch (err) {
    alert(`Couldn't load model: ${(err as Error).message}`);
  }
};
for (const el of $$('[data-p3]')) {
  const k = el.dataset.p3 as keyof typeof previewOpts;
  if (el.type === 'checkbox') el.checked = !!previewOpts[k]; else el.value = String(previewOpts[k]);
  el.addEventListener('input', () => {
    (previewOpts as any)[k] = el.type === 'checkbox' ? el.checked : k === 'repeat' ? +el.value : el.value;
    preview.set();
  });
}

// ---------- keyboard ----------
const SYMS: Sym[] = ['none', 'x', 'y', 'xy', 'diag', 'radial'];
addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' && (t as HTMLInputElement).type !== 'range') return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === 'Alt') { altHeld = true; e.preventDefault(); return; }
  if (e.key === ' ') { view.space = true; e.preventDefault(); return; }
  if (mod) {
    const acts: Record<string, () => void> = {
      z: () => (e.shiftKey ? doc.redo() : doc.undo()), y: () => doc.redo(), s: () => saveDoc(e.shiftKey ? 'project' : undefined), o: openFile,
      c: () => selAction('copy'), x: () => selAction('cut'), a: () => selAction('all'),
    };
    if (acts[k]) { e.preventDefault(); acts[k](); }
    return; // Ctrl+V goes through the paste event (handles OS clipboard images too)
  }
  const tool = TOOLS.find((x) => x[2] === k);
  if (tool) return setTool(tool[0]);
  const keys: Record<string, () => void> = {
    o: () => setTool('move'),
    x: () => { [opts.primary, opts.secondary] = [opts.secondary, opts.primary]; refreshPalette(); },
    '[': () => setOpt('size', Math.max(1, opts.size - 1)),
    ']': () => setOpt('size', Math.min(64, opts.size + 1)),
    w: () => { $('#wrap').checked = !$('#wrap').checked; setting(); },
    s: () => { $<HTMLSelectElement>('#sym').value = SYMS[(SYMS.indexOf(doc.settings.sym) + 1) % SYMS.length]; setting(); },
    '0': () => view.fit(),
    '=': () => view.zoomAt(innerWidth / 2, innerHeight / 2, 1.25), '+': () => view.zoomAt(innerWidth / 2, innerHeight / 2, 1.25),
    '-': () => view.zoomAt(innerWidth / 2, innerHeight / 2, 0.8),
    tab: togglePanel,
    delete: () => selAction('clear'), backspace: () => selAction('clear'),
    escape: () => cancelFloat(doc) || selAction('none'),
    enter: () => commitFloat(doc),
  };
  if (keys[k]) { e.preventDefault(); keys[k](); }
});
addEventListener('keyup', (e) => {
  if (e.key === 'Alt') altHeld = false;
  if (e.key === ' ') view.space = false;
});
addEventListener('blur', () => { altHeld = false; view.space = false; });
addEventListener('paste', async (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (f) setClipboard(await blobToImageData(f));
  selAction('paste');
});

// ---------- boot ----------
syncOpts();
setTool('pencil');
hook(doc);
syncHeader();
refreshPalette();
doc.changed(true);
preview.set();
requestAnimationFrame(() => view.fit());
restore().then((d) => { booted = true; if (d) setDoc(d); else save(); showName(); });

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('sw.js');
if (import.meta.env.DEV) (window as any).app = { get doc() { return doc; }, opts, setTool };
