import type { Doc } from './doc';
import { saveAs, pickFile, blobToImageData } from './io';
import { eq, extractPalette, remap, type RGBA } from './paint';
import { opts } from './tools';

export const hex = (c: RGBA) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): RGBA => [1, 3, 5].map((i) => parseInt(h.replace('#', '').padStart(7, '#').slice(i, i + 2), 16)).concat(255) as RGBA;

/** .gpl (GIMP) or .hex (Lospec, one rrggbb per line). */
export function parsePalette(text: string): RGBA[] {
  if (text.startsWith('GIMP Palette'))
    return text.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/)).filter(Boolean).map((m) => [+m![1], +m![2], +m![3], 255]);
  return text.split(/\s+/).filter((l) => /^#?[0-9a-f]{6}$/i.test(l)).map(fromHex);
}
const toGpl = (p: RGBA[]) => 'GIMP Palette\nName: texture\n#\n' + p.map((c) => `${c[0]} ${c[1]} ${c[2]}\t${hex(c)}`).join('\n') + '\n';
const toHex = (p: RGBA[]) => p.map((c) => hex(c).slice(1)).join('\n') + '\n';

function rgb2hsv([r, g, b]: RGBA): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
  const h = d === 0 ? 0 : v === r ? ((g - b) / d) % 6 : v === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, v ? d / v : 0, v];
}
function hsv2rgb(h: number, s: number, v: number): RGBA {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1), 255];
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Move hue toward target by at most `step` degrees. */
const toward = (h: number, target: number, step: number) => {
  const d = ((target - h + 540) % 360) - 180;
  return (h + Math.sign(d) * Math.min(Math.abs(d), step) + 360) % 360;
};

/** Classic pixel-art ramp: darker steps drift toward blue, lighter toward yellow. Dark→light. */
export function hueShiftRamp(base: RGBA, each: number, shift: number): RGBA[] {
  const [h, s, v] = rgb2hsv(base), out: RGBA[] = [];
  for (let i = -each; i <= each; i++) {
    const hh = i < 0 ? toward(h, 240, -i * shift) : toward(h, 60, i * shift);
    const vv = i < 0 ? v * (1 + i / (each + 1)) : v + (1 - v) * (i / (each + 1)) * 0.9;
    out.push(i === 0 ? base : hsv2rgb(hh, clamp01(s + (i < 0 ? 0.05 : -0.12) * Math.abs(i)), clamp01(vv)));
  }
  return out;
}
export const lerpRamp = (a: RGBA, b: RGBA, n: number): RGBA[] =>
  Array.from({ length: n }, (_, i) => a.map((v, k) => Math.round(v + ((b[k] - v) * i) / (n - 1))) as RGBA);

const lum = (c: RGBA) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

export function renderPalette(el: HTMLElement, doc: Doc, refresh: () => void) {
  const addColors = (cs: RGBA[]) => { for (const c of cs) if (!doc.palette.some((p) => eq(p, c))) doc.palette.push(c); };
  const sw = (c: RGBA, extra = '') => `<button class="sw ${extra}" style="background:${hex(c)}" title="${hex(c)}"></button>`;

  el.innerHTML = `
    <div class="row">
      <div class="cur">
        <input type="color" id="pc" value="${hex(opts.primary)}" title="Primary (left click)">
        <input type="color" id="sc" value="${hex(opts.secondary)}" title="Secondary (right click / long press)">
      </div>
      <canvas id="mix" width="8" height="4" title="50% dither mix of primary + secondary"></canvas>
      <button id="swap" title="Swap (X)">⇄</button>
    </div>
    <div class="swatches">${doc.palette.map((c) => sw(c, eq(c, opts.primary) ? 'p' : eq(c, opts.secondary) ? 's' : '')).join('')}</div>
    <div class="row wrap">
      <button id="add" title="Add primary to palette">+</button>
      <button id="del" title="Remove primary from palette">−</button>
      <button id="sort" title="Sort by lightness">Sort</button>
      <button id="imp" title="Import .gpl / .hex / image">Import</button>
      <button id="gpl">.gpl</button><button id="hexb">.hex</button>
      <button id="ext" title="Replace palette with colors from the image">Extract</button>
      <select id="remap" title="Quantize active layer to palette">
        <option value="">Remap…</option><option value="nearest">nearest</option><option value="ordered">ordered dither</option><option value="fs">Floyd–Steinberg</option>
      </select>
    </div>
    <div class="row wrap">
      Ramp <input id="rn" type="number" min="1" max="8" value="2" title="Steps each side / lerp count">
      <input id="rh" type="number" min="0" max="60" value="12" title="Hue shift per step (°)">°
      <button id="rhs" title="Hue-shifted ramp around primary">Hue-shift</button>
      <button id="rl" title="Lerp primary→secondary">Lerp</button>
    </div>
    <div class="ramps">${doc.ramps.map((r, i) => `<div class="ramp ${i === opts.ramp ? 'on' : ''}" data-i="${i}">${r.map((c) => sw(c)).join('')}<button class="x" data-i="${i}">×</button></div>`).join('')}</div>
    <div class="stats" id="stats"></div>`;

  const $ = (id: string) => el.querySelector('#' + id) as HTMLInputElement;
  const mix = $('mix') as unknown as HTMLCanvasElement, g = mix.getContext('2d')!;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) { g.fillStyle = hex((x + y) % 2 ? opts.secondary : opts.primary); g.fillRect(x, y, 1, 1); }

  $('pc').oninput = () => { opts.primary = fromHex($('pc').value); refresh(); };
  $('sc').oninput = () => { opts.secondary = fromHex($('sc').value); refresh(); };
  $('swap').onclick = () => { [opts.primary, opts.secondary] = [opts.secondary, opts.primary]; refresh(); };
  el.querySelectorAll<HTMLButtonElement>('.swatches .sw, .ramp .sw').forEach((b) => {
    const c = fromHex(b.title);
    b.onclick = () => { opts.primary = c; refresh(); };
    b.oncontextmenu = (e) => { e.preventDefault(); opts.secondary = c; refresh(); }; // long-press on Android
  });
  // drag a palette swatch onto another to reorder (pointer events, so it works with touch too)
  const swatches = [...el.querySelectorAll<HTMLButtonElement>('.swatches .sw')];
  let from = -1;
  swatches.forEach((b, i) => (b.onpointerdown = () => (from = i)));
  el.onpointerup = (e) => {
    const to = swatches.indexOf(document.elementFromPoint(e.clientX, e.clientY)?.closest('.swatches .sw') as HTMLButtonElement);
    if (from >= 0 && to >= 0 && to !== from) { doc.palette.splice(to, 0, ...doc.palette.splice(from, 1)); refresh(); }
    from = -1;
  };
  el.querySelectorAll<HTMLElement>('.ramp').forEach((r) => (r.onclick = (e) => {
    if (!(e.target as HTMLElement).classList.contains('sw')) { opts.ramp = +r.dataset.i!; refresh(); }
  }));
  el.querySelectorAll<HTMLButtonElement>('.ramp .x').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); doc.ramps.splice(+b.dataset.i!, 1); refresh(); }));

  $('add').onclick = () => { addColors([opts.primary]); refresh(); };
  $('del').onclick = () => { doc.palette = doc.palette.filter((c) => !eq(c, opts.primary)); refresh(); };
  $('sort').onclick = () => { doc.palette.sort((a, b) => lum(a) - lum(b)); refresh(); };
  $('gpl').onclick = () => saveAs(new Blob([toGpl(doc.palette)]), 'palette', 'gpl').catch((e) => alert(e.message));
  $('hexb').onclick = () => saveAs(new Blob([toHex(doc.palette)]), 'palette', 'hex').catch((e) => alert(e.message));
  $('imp').onclick = async () => {
    const f = await pickFile('.gpl,.hex,.txt,image/*');
    if (!f) return;
    const p = f.type.startsWith('image/') ? extractPalette(await blobToImageData(f), 256) : parsePalette(await f.text());
    if (p.length) { doc.palette = p; refresh(); }
  };
  $('ext').onclick = () => {
    const n = +(prompt('Max colors', String(Math.max(2, doc.palette.length))) ?? 0);
    if (n > 0) { doc.palette = extractPalette(doc.flattened(), n); refresh(); }
  };
  $('remap').onchange = () => {
    const m = $('remap').value as 'nearest' | 'ordered' | 'fs';
    if (m && doc.palette.length) doc.edit((img) => remap(img, doc.palette, m, doc.settings.wrap));
    $('remap').value = '';
  };
  $('rhs').onclick = () => { const r = hueShiftRamp(opts.primary, +$('rn').value, +$('rh').value); doc.ramps.push(r); addColors(r); opts.ramp = doc.ramps.length - 1; refresh(); };
  $('rl').onclick = () => { const r = lerpRamp(opts.primary, opts.secondary, Math.max(2, +$('rn').value * 2 + 1)); doc.ramps.push(r); addColors(r); opts.ramp = doc.ramps.length - 1; refresh(); };
  updateStats(el, doc);
}

/** Unique colors in the image and how many are off-palette. */
export function updateStats(el: HTMLElement, doc: Doc) {
  const s = el.querySelector('#stats');
  if (!s) return;
  const d = doc.flattened().data, seen = new Set<number>();
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  const pal = new Set(doc.palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]));
  const off = [...seen].filter((c) => !pal.has(c)).length;
  s.textContent = `${seen.size} colors used · ${doc.palette.length} in palette${off ? ` · ${off} off-palette` : ''}`;
}
