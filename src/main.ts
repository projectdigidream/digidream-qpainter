import './style.css';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Doc, newLayer } from './doc';
import { apngBlob, baseName, blobToImageData, pickFile, pickFiles, writeToModule, libDelete, libList, libLoad, libPut, loadProject, openAny, pngBlob, projectBlob, restore, sameFile, saveAs, sheetBlob, writeRef } from './io';
import { PATTERNS, blend, getPx, mod, offset, type Sym } from './paint';
import { hex, renderPalette, updateStats } from './palette';
import { MESHES, createPreview, previewOpts, type PaintEvent } from './preview3d';
import { cancelFloat, clearSel, commitFloat, copySel, makeTools, opts, pasteClip, pattern, setClipboard, transformSel, type P, type Tool } from './tools';
import { View, viewOpts } from './view';
import { startEmbed, type Embed } from './host';
import { toolIcon } from './icons';
import { aseFps, readAseprite } from './aseprite';
import { FACES, SKY_DEFAULTS, SKY_KINDS, THREE_FACE_NAMES, engineName, faceRects, fitsSky, setSkyLine, skyLine, skyPictures, skySize, type SkyKind } from './sky';

const $ = <T extends HTMLElement = HTMLInputElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLInputElement>(s: string) => [...document.querySelectorAll<T>(s)];

let doc = new Doc(32, 32);
let tools = makeTools(doc, () => refreshPalette());
let current = 'pencil';
let altHeld = false;

const TOOLS: [string, string, string][] = [
  // id, key, title (the icon is icons.ts's, by id)
  ['pencil', 'p', 'Pencil'], ['brush', 'b', 'Soft brush'], ['eraser', 'e', 'Eraser'],
  ['dither', 'd', 'Dither brush'], ['shade', 'h', 'Ramp shade brush'], ['noise', 'n', 'Noise / scatter'],
  ['replace', 'r', 'Replace color brush'], ['smooth', 'a', 'Smooth / AA helper'],
  ['line', 'l', 'Line (Shift = 45°)'], ['rect', 'u', 'Rectangle (Shift = square)'], ['ellipse', 'c', 'Ellipse (Shift = circle)'],
  ['fill', 'g', 'Fill'], ['gradient', 'j', 'Dithered gradient'], ['picker', 'i', 'Eyedropper (or hold Alt)'],
  ['select', 'm', 'Select'], ['move', 'v', 'Move selection / offset layer (O)'],
];

const view = new View($<HTMLCanvasElement>('#view'), () => doc,
  (): Tool => (altHeld && current !== 'move' ? tools.picker : tools[current]),
  (x, y) => { Object.assign(doc.settings, { ax: x, ay: y }); view.render(); save(); });
// The 3D preview (and the editor while playing) shows `anim`: the current frame, or the playing one.
const anim = document.createElement('canvas');
const preview = createPreview($('#p3d'), anim, paint3d);

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
let embed: Embed | null = null; // inside another app (host.ts): the host keeps the texture, not the library
const save = () => { if (embed) { doc.unsaved = true; return embed.changed(); } if (!booted) return; doc.unsaved = true; showName(); clearTimeout(saveTimer); saveTimer = window.setTimeout(() => libPut(doc), 800); };
function hook(d: Doc) {
  d.onChange = (final) => {
    if (!playTimer) showFrame(d.frame);
    view.render();
    if (final) { renderLayers(); renderFrames(); updateStats($('#pal'), d); save(); }
  };
}

// ---------- animation ----------
let playTimer = 0, playFrame = 0;
const onionCv = document.createElement('canvas');
view.image = () => (playTimer ? anim : doc.comp);
view.onion = () => (!playTimer && $('#onion').checked && doc.frames > 1 ? onionCv : null);
/** Put frame `k` into the canvas the 3D preview (and playback) shows. */
function showFrame(k: number) {
  if (k === doc.frame) {
    Object.assign(anim, { width: doc.w, height: doc.h });
    anim.getContext('2d')!.drawImage(doc.comp, 0, 0);
  } else doc.composite(k, anim);
  preview.update();
}
function play(on: boolean) {
  clearInterval(playTimer);
  playTimer = 0;
  if (on && doc.frames > 1) {
    playFrame = doc.frame;
    playTimer = window.setInterval(() => {
      playFrame = (playFrame + 1) % doc.frames;
      showFrame(playFrame);
      view.render();
      frameLabel(playFrame);
    }, 1000 / doc.fps);
  } else showFrame(doc.frame);
  $$<HTMLButtonElement>('.playbtn').forEach((b) => (b.textContent = playTimer ? '❚❚' : '▶\uFE0E')); // \uFE0E: never the emoji
  frameLabel(doc.frame);
  view.render();
}
function goFrame(k: number) {
  play(false);
  doc.setFrame(k);
  renderFrames();
}
const frameLabel = (k: number) => $$('.framelabel').forEach((e) => (e.textContent = `${k + 1}/${doc.frames}`));
function renderFrames() {
  const el = $('#frames');
  // one thumbnail per frame; reuse canvases so the strip doesn't flicker
  while (el.children.length > doc.frames) el.lastChild!.remove();
  while (el.children.length < doc.frames) el.appendChild(document.createElement('canvas'));
  [...el.children].forEach((c, k) => {
    const cv = c as HTMLCanvasElement;
    doc.composite(k, cv);
    cv.classList.toggle('on', k === doc.frame);
    cv.title = `Frame ${k + 1}`;
    cv.onclick = () => goFrame(k);
  });
  if (doc.frames > 1) doc.composite((doc.frame - 1 + doc.frames) % doc.frames, onionCv); // previous frame (loops)
  $('#fps').value = String(doc.fps);
  frameLabel(doc.frame);
  el.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function frameOp(op: string) {
  if (op === 'play') return play(!playTimer);
  if (op === 'prev' || op === 'next') return goFrame(doc.frame + (op === 'next' ? 1 : -1));
  play(false);
  if (op === 'add' || op === 'dup') doc.addFrame(op === 'dup');
  if (op === 'del') doc.deleteFrame();
  if (op === 'left' || op === 'right') doc.moveFrame(op === 'left' ? -1 : 1);
  if (op === 'split') {
    const n = Math.round(+(prompt('Number of frames in this sheet', String(doc.h > doc.w ? doc.h / doc.w : doc.w / doc.h)) ?? 0));
    const vertical = doc.h % n === 0 && doc.h >= doc.w;
    if (n > 1 && !doc.splitFrames(n, vertical)) alert(`Can't split: the texture must be a single frame whose ${vertical ? 'height' : 'width'} divides evenly by ${n}.`);
    else view.fit();
  }
}
$$<HTMLButtonElement>('[data-f]').forEach((b) => (b.onclick = () => frameOp(b.dataset.f!)));
$('#fps').onchange = () => { doc.fps = Math.min(60, Math.max(1, +$('#fps').value || 8)); if (playTimer) play(true); save(); };
$('#onion').onchange = () => view.render();
// painting while it plays would hit a moving target: stop first
$('#view').addEventListener('pointerdown', () => { if (playTimer) play(false); }, true);
$$<HTMLButtonElement>('[data-b2]').forEach((b) => (b.onclick = () => {
  const a = b.dataset.b2!;
  if (a === 'undo') doc.undo(); else if (a === 'redo') doc.redo(); else if (a === 'panel') togglePanel(); else frameOp(a);
}));
function showName() {
  $('#docname').textContent = doc.name + (doc.file && doc.unsaved ? ' •' : '');
  $('#docname').title = doc.file ? `Linked to a ${doc.file.kind === 'png' ? 'PNG' : 'project'} file${doc.unsaved ? ' (unsaved changes)' : ''}. Click to rename.` : 'Not saved to a file yet. Click to rename.';
}

// an animated texture saved as PNG becomes a vertical sprite sheet (reopening offers to split it again)
const fileBlob = (kind: 'project' | 'png') => (kind === 'project' ? projectBlob(doc) : doc.frames > 1 ? sheetBlob(doc, 1, true) : pngBlob(doc, 1));
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
  play(false);
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
for (const [id, key, title] of TOOLS) {
  const b = document.createElement('button');
  Object.assign(b, { innerHTML: toolIcon(id), title: `${title} (${key.toUpperCase()})` });
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
  $('#optshead').textContent = TOOLS.find((t) => t[0] === id)![2].replace(/ \(.*\)$/, '');
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
  $('#patwarn').textContent = doc.settings.wrap && (doc.w % p.n || doc.h % p.n) ? `⚠\uFE0E ${p.n}px pattern won't tile at ${doc.w}×${doc.h}` : '';
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
    if (op === 'add') { const l = newLayer(`Layer ${L.length + 1}`, doc.w, doc.h, doc.frames); l.data = l.cels[doc.frame]; L.splice(a + 1, 0, l); doc.active++; }
    if (op === 'dup') { const cels = L[a].cels.map((c) => new ImageData(c.data.slice(), doc.w, doc.h)); L.splice(a + 1, 0, { ...L[a], name: L[a].name + ' copy', cels, data: cels[doc.frame] }); doc.active++; }
    if (op === 'del') { L.splice(a, 1); doc.active = Math.max(0, a - 1); }
    if (op === 'up' || op === 'down') { const b = op === 'up' ? a + 1 : a - 1; [L[a], L[b]] = [L[b], L[a]]; doc.active = b; }
    if (op === 'merge') {
      const top = L[a], bot = L[a - 1];
      bot.cels.forEach((b, f) => {
        for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) b.data.set(blend(getPx(b, x, y), getPx(top.cels[f], x, y), top.visible ? top.opacity : 0), (y * doc.w + x) * 4);
      });
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
  // settings that only mean something while another is on show only then
  $('#tiles').style.display = s.wrap && !s.sky ? '' : 'none';
  $('#symc').style.display = s.sym !== 'none' ? '' : 'none';
  $('#snap').style.display = s.lock ? '' : 'none';
  $<HTMLSelectElement>('#snap').value = s.snap;
  $<HTMLSelectElement>('#sky').value = s.sky ?? '';
  // only the settings the engine reads for this kind (server/src/sky.hpp)
  $$('[data-sky]').forEach((e) => (e.style.display = s.sky && e.dataset.sky!.split(' ').includes(s.sky) ? '' : 'none'));
  $('#skyrepeat').value = String(s.skyParams.repeat);
  $('#skyheight').value = String(s.skyParams.height);
  $('#skyyaw').value = String(s.skyParams.yaw);
  preview.setSky(s.sky, s.skyParams);
  // object-only preview controls do nothing inside a sky
  $$('[data-p3=mesh], [data-p3=repeat], [data-p3=lit], #model').forEach((e) => ((e as HTMLInputElement).disabled = !!s.sky));
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

// ---------- skybox (the DoomNet engine's skies, docs/SKY.md) ----------
$<HTMLSelectElement>('#sky').innerHTML += Object.entries(SKY_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$<HTMLSelectElement>('#sky').onchange = () => {
  const t = ($<HTMLSelectElement>('#sky').value || null) as SkyKind | null;
  if (t && !fitsSky(t, doc.w, doc.h)) {
    alert(`A cube sky is edited as the engine's cross: a 4:3 image of square faces (east, south, west, north across the middle; up and down above and below south). This texture is ${doc.w}×${doc.h}. Use New… → Cube, or Import faces….`);
    return syncHeader();
  }
  doc.settings.sky = t;
  syncHeader();
  view.render();
  save();
};
for (const [id, key, lo] of [['#skyrepeat', 'repeat', 0.001], ['#skyheight', 'height', 0.001], ['#skyyaw', 'yaw', -1e6]] as const)
  $(id).addEventListener('change', () => {
    const v = +$(id).value;
    if (Number.isFinite(v) && v >= lo) doc.settings.skyParams[key] = v; // the engine refuses repeat/height ≤ 0
    syncHeader();
    view.render();
    save();
  });

/** One cube face of the current frame, as a PNG. */
function faceBlob(i: number): Promise<Blob> {
  const r = faceRects('cube', doc.w)[i], c = Object.assign(document.createElement('canvas'), { width: r.w, height: r.h });
  c.getContext('2d')!.putImageData(doc.flattened(), -r.x, -r.y);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}
$('#skyexport').onclick = async () => {
  const k = doc.settings.sky;
  if (!k) return;
  doc.flush();
  const base = engineName(prompt(`Texture name for the sky picture${k === 'cube' ? 's (each face gets _east, _west, … added)' : ''}:`, engineName(doc.name).toUpperCase()) ?? '');
  if (base === 'sky' && !confirm('Use the name "sky"?')) return;
  const level = (prompt('Which level gets this sky? A level name like map12, or "default" for every level without its own.', 'default') ?? '').trim();
  if (!/^[A-Za-z0-9_\-]+$/.test(level)) return;
  const line = skyLine(level, k, base, doc.settings.skyParams);
  const names = skyPictures(k, base);
  try {
    const files = await Promise.all(names.map(async (n, i) => ({ name: n + '.png', blob: k === 'cube' ? await faceBlob(i) : await pngBlob(doc, 1) })));
    const where = await writeToModule(files, (txt) => setSkyLine(txt, line));
    if (where === 'module') alert(`Done: ${files.length} picture${files.length > 1 ? 's' : ''} in assets/textures/, and module.txt now says:\n\n${line}`);
    else if (where) prompt(`Wrote ${files.map((f) => f.name).join(', ')}${where === 'download' ? ' (downloaded)' : ''}. Put ${files.length > 1 ? 'them' : 'it'} in the module's assets/textures/ and add this line to its module.txt:`, line);
  } catch (e) {
    alert(`Couldn't export: ${(e as Error).message}`);
  }
};
$('#skyfaces').onclick = async () => {
  const files = await pickFiles('image/*');
  if (!files.length) return;
  // match each face by name: …_east … _down, or three.js's px nx py ny pz nz
  const stem = (f: File) => baseName(f.name).toLowerCase();
  const found = FACES.map((name, i) => files.find((f) => new RegExp(`(^|[^a-z])(${name}|${THREE_FACE_NAMES[i]})$`).test(stem(f))));
  const missing = FACES.filter((_, i) => !found[i]);
  if (missing.length) return alert(`Pick six pictures named …_east, _west, _north, _south, _up, _down (or three.js's px nx py ny pz nz). Missing: ${missing.join(', ')}.`);
  try {
    const imgs = await Promise.all(found.map((f) => blobToImageData(f!)));
    const f = imgs[0].width;
    if (imgs.some((im) => im.width !== f || im.height !== f)) return alert('The six faces must be square and all the same size.');
    const d = new Doc(4 * f, 3 * f), g = Object.assign(document.createElement('canvas'), { width: 4 * f, height: 3 * f }).getContext('2d')!;
    faceRects('cube', 4 * f).forEach((r, i) => g.putImageData(imgs[i], r.x, r.y));
    d.layers[0].data = d.layers[0].cels[0] = g.getImageData(0, 0, 4 * f, 3 * f);
    Object.assign(d, { palette: doc.palette, ramps: doc.ramps });
    Object.assign(d.settings, { ...doc.settings, ax: 2 * f, ay: 1.5 * f, sky: 'cube', wrap: false, skyParams: { ...SKY_DEFAULTS } });
    d.name = stem(found[0]!).replace(/[_\-. ]?(west|px)$/, '') || 'Sky';
    await switchTo(d);
  } catch (e) {
    alert(`Couldn't import: ${(e as Error).message}`);
  }
};

$<HTMLSelectElement>('#new').onchange = () => {
  const v = $<HTMLSelectElement>('#new').value;
  $<HTMLSelectElement>('#new').value = '';
  let w = +v, h = +v, sky: SkyKind | null = null;
  if (v === 'custom') [w, h] = (prompt('Size (W×H)', '64x32') ?? '').split(/[x×*, ]+/).map(Number);
  if (v.startsWith('sky:')) {
    sky = v.slice(4) as SkyKind;
    const ask = { strip: ['Width in pixels (DOOM\'s skies are 256 × 128)', '256'], panorama: ['Width in pixels (2:1; 2048 suits phones)', '1024'], cube: ['Face size in pixels (512 suits phones)', '128'] }[sky];
    const n = Math.round(+(prompt(ask[0], ask[1]) ?? 0));
    if (n % 2) return alert('Use an even size.');
    [w, h] = n > 0 ? skySize(sky, n) : [0, 0];
  }
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) return;
  const d = new Doc(w, h);
  Object.assign(d, { palette: doc.palette, ramps: doc.ramps }); // keep palette between textures
  Object.assign(d.settings, { ...doc.settings, ax: w / 2, ay: h / 2, sky, wrap: sky ? false : doc.settings.wrap, skyParams: { ...SKY_DEFAULTS } });
  d.name = sky ? `Sky ${w}×${h}` : `Untitled ${w}×${h}`;
  switchTo(d);
};
$('#open').onclick = openFile;
/** An Aseprite file as a qPainter texture: layers, frames, palette and speed. */
async function asepriteDoc(buf: ArrayBuffer): Promise<Doc> {
  const a = await readAseprite(buf);
  if (!a.layers.length) throw new Error('the file has no layers qPainter can show');
  const d = new Doc(a.w, a.h);
  d.layers = a.layers.map((l) => {
    const cels = l.cels.map((c) => new ImageData(c, a.w, a.h));
    return { name: l.name, visible: l.visible, opacity: l.opacity, cels, data: cels[0] };
  });
  d.active = d.layers.length - 1;
  Object.assign(d, { palette: a.palette.length ? a.palette : doc.palette, ramps: doc.ramps, fps: aseFps(a.durations) });
  Object.assign(d.settings, { ...doc.settings, ax: a.w / 2, ay: a.h / 2, sky: null, skyParams: { ...SKY_DEFAULTS } });
  if (a.warnings.length) setTimeout(() => alert(`Opened from Aseprite, with some differences:\n\n• ${a.warnings.join('\n• ')}`), 300);
  return d;
}

async function openFile() {
  try {
    const f = await openAny();
    if (!f) return;
    let d: Doc;
    const ase = /\.(aseprite|ase)$/i.test(f.name);
    if (/\.json$/i.test(f.name)) d = await loadProject(f.blob);
    else if (ase) d = await asepriteDoc(await f.blob.arrayBuffer());
    else {
      const img = await blobToImageData(f.blob);
      d = new Doc(img.width, img.height);
      d.layers[0].data = d.layers[0].cels[0] = img;
      Object.assign(d, { palette: doc.palette, ramps: doc.ramps });
      Object.assign(d.settings, { ...doc.settings, ax: img.width / 2, ay: img.height / 2, sky: null, skyParams: { ...SKY_DEFAULTS } });
      const n = img.height / img.width;
      if (Number.isInteger(n) && n > 1 && confirm(`This looks like a vertical sprite sheet of ${n} frames. Open it as an animation?`)) d.splitFrames(n, true);
    }
    d.name = baseName(f.name);
    // qPainter doesn't write .aseprite, so an Aseprite file isn't linked: Save asks where to put a project or PNG
    d.file = f.ref && !ase ? { ref: f.ref, kind: /\.json$/i.test(f.name) ? 'project' : 'png' } : null;
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
  const [kind, sc] = $<HTMLSelectElement>('#export').value.split(':'), s = +sc;
  $<HTMLSelectElement>('#export').value = '';
  if (!kind) return;
  const suffix = (s > 1 ? `@${s}x` : '') + (kind === 'png' && doc.frames > 1 ? `-frame${doc.frame + 1}` : kind === 'sheetv' || kind === 'sheeth' ? '-sheet' : '');
  try {
    const blob = kind === 'apng' ? await apngBlob(doc, s) : kind === 'png' ? await pngBlob(doc, s) : await sheetBlob(doc, s, kind === 'sheetv');
    await saveAs(blob, doc.name + suffix, 'png');
  } catch (e) {
    alert(`Couldn't export: ${(e as Error).message}`);
  }
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
  const tool = TOOLS.find((x) => x[1] === k);
  if (tool) return setTool(tool[0]);
  const keys: Record<string, () => void> = {
    o: () => setTool('move'),
    x: () => { [opts.primary, opts.secondary] = [opts.secondary, opts.primary]; refreshPalette(); },
    '[': () => setOpt('size', Math.max(1, opts.size - 1)),
    ']': () => setOpt('size', Math.min(64, opts.size + 1)),
    w: () => { $('#wrap').checked = !$('#wrap').checked; setting(); },
    s: () => { $<HTMLSelectElement>('#sym').value = SYMS[(SYMS.indexOf(doc.settings.sym) + 1) % SYMS.length]; setting(); },
    '0': () => view.fit(),
    ',': () => frameOp('prev'), '.': () => frameOp('next'), f: () => frameOp('play'),
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
embed = startEmbed({ current: () => doc, setDoc });
if (!embed) {
  restore().then((d) => { booted = true; if (d) setDoc(d); else save(); showName(); });
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('sw.js');
}
if (import.meta.env.DEV) (window as any).app = { get doc() { return doc; }, opts, setTool };
