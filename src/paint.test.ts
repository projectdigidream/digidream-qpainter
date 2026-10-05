import { expect, test } from 'vitest';

// Node has no ImageData.
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
}
(globalThis as any).ImageData = FakeImageData;

const P = await import('./paint');
const { makeCtx, plot, getPx, floodRegion, snap, remap, ditherFn, PATTERNS, rampStep, extractPalette } = P;
type RGBA = [number, number, number, number];

const R: RGBA = [255, 0, 0, 255], B: RGBA = [0, 0, 255, 255], K: RGBA = [0, 0, 0, 255], W: RGBA = [255, 255, 255, 255];
const img = (w = 4, h = 4) => new ImageData(w, h);
const set = (c: RGBA) => () => c;
const count = (im: ImageData, c: RGBA) => {
  let n = 0;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) if (P.eq(getPx(im, x, y), c)) n++;
  return n;
};

test('wrap plot lands on opposite edge, clip drops it', () => {
  const a = img();
  plot(makeCtx(a, { wrap: true }), -1, -1, 1, set(R));
  expect(getPx(a, 3, 3)).toEqual(R);
  const b = img();
  plot(makeCtx(b), -1, -1, 1, set(R));
  expect(count(b, R)).toBe(0);
});

test('xy symmetry makes 4 pixels, radial 4 makes 4', () => {
  const a = img(8, 8);
  plot(makeCtx(a, { sym: 'xy' }), 1, 2, 1, set(R));
  expect([getPx(a, 1, 2), getPx(a, 6, 2), getPx(a, 1, 5), getPx(a, 6, 5)]).toEqual([R, R, R, R]);
  const b = img(8, 8);
  plot(makeCtx(b, { sym: 'radial', radial: 4 }), 1, 2, 1, set(R));
  expect(count(b, R)).toBe(4);
});

test('flood fill crosses the seam only in wrap mode', () => {
  const a = img(4, 1);
  a.data.set(K, 4 * 1); // x=1 is a wall: [.,K,.,.]
  expect(floodRegion(a, 0, 0, false, 0, true).length).toBe(1);
  expect(floodRegion(a, 0, 0, true, 0, true).length).toBe(3);
});

test('palette snap: nearest and alpha threshold', () => {
  expect(snap([K, W], [200, 200, 200, 255], 0, 0, 'nearest')).toEqual(W);
  expect(snap([K, W], [200, 200, 200, 100], 0, 0, 'nearest')).toEqual([0, 0, 0, 0]);
});

test('50% checker dither alternates and lines up across the wrap seam', () => {
  const a = img(4, 4), c = makeCtx(a, { wrap: true }), fn = ditherFn(PATTERNS.checker, 0.5, R, B);
  for (let y = -1; y < 5; y++) for (let x = -1; x < 5; x++) plot(c, x, y, 1, fn);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(getPx(a, x, y)).toEqual((x + y) % 2 ? B : R);
});

test('ramp brush with stroke mask moves exactly one step', () => {
  const ramp: RGBA[] = [K, R, W];
  const a = img(2, 1), c = makeCtx(a, { mask: new Uint8Array(2) });
  plot(c, 0, 0, 1, () => K);
  c.mask = new Uint8Array(2); // new stroke
  for (let i = 0; i < 5; i++) plot(c, 0, 0, 1, (d) => rampStep([ramp], d, 1));
  expect(getPx(a, 0, 0)).toEqual(R);
});

test('floyd-steinberg output contains only palette colors', () => {
  const a = img(8, 8);
  for (let i = 0; i < 64; i++) a.data.set([i * 4, 128, 255 - i * 4, 255], i * 4);
  const pal = [K, W, R, B];
  remap(a, pal, 'fs', true);
  for (let i = 0; i < 64; i++) expect(pal.some((p) => P.eq(p, getPx(a, i % 8, i >> 3)))).toBe(true);
});

test('median cut limits palette size', () => {
  const a = img(16, 16);
  for (let i = 0; i < 256; i++) a.data.set([i, 255 - i, (i * 7) % 256, 255], i * 4);
  expect(extractPalette(a, 8).length).toBe(8);
});

test('undo restores exact bytes', async () => {
  (globalThis as any).document = { createElement: () => ({ getContext: () => null }) };
  const { Doc } = await import('./doc');
  const d = new Doc(4, 4);
  d.changed = () => {};
  const before = d.layer.data.data.slice();
  d.begin();
  const c = d.ctx();
  plot(c, 1, 1, 1, set(R));
  d.end(c.dirty);
  d.undo();
  expect(d.layer.data.data).toEqual(before);
  d.redo();
  expect(getPx(d.layer.data, 1, 1)).toEqual(R);
});

test('pattern offset shifts where the dither lands', () => {
  const { shiftPattern } = P;
  const draw = (p: typeof PATTERNS.checker) => {
    const a = img(4, 4), c = makeCtx(a);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) plot(c, x, y, 1, ditherFn(p, 0.5, R, B));
    return a;
  };
  const base = draw(PATTERNS.checker), moved = draw(shiftPattern(PATTERNS.checker, 1, 0));
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(getPx(moved, x, y)).toEqual(getPx(base, (x + 3) % 4, y)); // moved right by 1
  const b4 = PATTERNS.bayer4, s = shiftPattern(b4, 2, 3);
  expect(P.threshold(s, 5, 7)).toBe(P.threshold(b4, 3, 4)); // (x-2, y-3)
  expect(shiftPattern(b4, 4, 4).t).toEqual(b4.t); // a full period is a no-op
});

test('APNG encoder: valid chunks, frame sequence and pixel data', async () => {
  const { encodeApng, crc32 } = await import('./apng');
  const frame = (v: number) => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(v) });
  const png = await encodeApng([frame(10), frame(20), frame(30)], 125);
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(png.buffer), chunks: { type: string; data: Uint8Array }[] = [];
  for (let o = 8; o < png.length; ) {
    const len = dv.getUint32(o), type = String.fromCharCode(...png.slice(o + 4, o + 8)), data = png.slice(o + 8, o + 8 + len);
    expect(dv.getUint32(o + 8 + len)).toBe(crc32(png.slice(o + 4, o + 8 + len))); // every CRC valid
    chunks.push({ type, data });
    o += 12 + len;
  }
  expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  const be = (d: Uint8Array, i: number) => new DataView(d.buffer, d.byteOffset).getUint32(i);
  expect(be(chunks[1].data, 0)).toBe(3); // frame count
  // sequence numbers run 0..4 across fcTL and fdAT, in order
  expect([chunks[2], chunks[4], chunks[5], chunks[6], chunks[7]].map((c) => be(c.data, 0))).toEqual([0, 1, 2, 3, 4]);
  expect(new DataView(chunks[2].data.buffer, chunks[2].data.byteOffset).getUint16(20)).toBe(125); // delay numerator (ms)
  // second frame's pixels decompress back to the input (after the per-row filter byte)
  const z = chunks[5].data.slice(4);
  const raw = new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  expect([...raw]).toEqual([0, 20, 20, 20, 20, 20, 20, 20, 20, 0, 20, 20, 20, 20, 20, 20, 20, 20]);
});

test('sky: cube faces round-trip and the cross stitches its edges like the cube', async () => {
  const { faceDir, dirFace, skyMap } = await import('./sky');
  for (let f = 0; f < 6; f++)
    for (const [s, t] of [[0, 0], [0.5, -0.25], [-0.9, 0.7]]) {
      const [g, s2, t2] = dirFace(faceDir(f, s, t));
      expect([g, +s2.toFixed(9), +t2.toFixed(9)]).toEqual([f, s, t]);
    }
  const F = 8, cross = skyMap('cube', 4 * F, 3 * F);
  // south (centre) → west (right of it) is a real cube edge: unchanged
  expect(cross(2 * F, F + 3, 2 * F - 1, F + 3)).toEqual([2 * F, F + 3]);
  // left of UP is empty in the cross: it continues on the top edge of EAST, up's top-left corner at east's top-left
  expect(cross(F - 1, 0, F, 0)).toEqual([0, F]);
  expect(cross(F - 1, F - 1, F, F - 1)).toEqual([F - 1, F]);
  // past north's right edge (off the image) continues on east's left edge: the cross's ends meet round the back
  expect(cross(4 * F, F + 2, 4 * F - 1, F + 2)).toEqual([0, F + 2]);
  // pixels outside every face are dropped when the stroke isn't on a face
  expect(cross(0, 0, 0, 0)).toBeNull();
  const pano = skyMap('panorama', 16, 8);
  expect(pano(-1, 3, 0, 3)).toEqual([15, 3]);
  expect(pano(2, -1, 2, 0)).toEqual([10, 0]); // over the pole
  expect(skyMap('strip', 16, 8)(3, -1, 3, 0)).toBeNull();
  expect(skyMap('strip', 16, 8)(16, 2, 15, 2)).toEqual([0, 2]);
});

test("sky: matches the DoomNet engine's own mapping and its docs/SKY.md", async () => {
  const { dirToUV, faceRects, FACES, skyLine, setSkyLine, STRIP_HORIZON, DOOM_SKY } = await import('./sky');
  const F = 16, W = 4 * F, H = 3 * F;
  const face = (d: [number, number, number]) => {
    const [u, v] = dirToUV('cube', d, W, H)!;
    return FACES[faceRects('cube', W).findIndex((r) => u * W >= r.x && u * W < r.x + r.w && v * H >= r.y && v * H < r.y + r.h)];
  };
  // directions in three.js's frame: north -z, east +x, south +z, up +y (the engine's)
  expect([face([1, 0, 0]), face([-1, 0, 0]), face([0, 0, -1]), face([0, 0, 1]), face([0, 1, 0]), face([0, -1, 0])])
    .toEqual(['east', 'west', 'north', 'south', 'up', 'down']);
  // "Facing south, east is on your left": looking south, a little left (toward east) lands on south's left half
  const leftOfSouth = dirToUV('cube', [0.3, 0, 1], W, H)!, south = faceRects('cube', W)[4];
  expect(leftOfSouth[0] * W < south.x + south.w / 2).toBe(true);
  // "Up's bottom edge meets south's top edge": looking south and up past 45° lands at the bottom of UP
  const [, vu] = dirToUV('cube', [0, 1.05, 1], W, H)!;
  expect(vu * H).toBeGreaterThan(F - 1);
  expect(vu * H).toBeLessThan(F);
  // panorama: centre column north, east at 3/4, west at 1/4
  expect(dirToUV('panorama', [0, 0, -1], 64, 32)).toEqual([0.5, 0.5]);
  expect(dirToUV('panorama', [1, 0, 0], 64, 32)![0]).toBeCloseTo(0.75);
  expect(dirToUV('panorama', [-1, 0, 0], 64, 32)![0]).toBeCloseTo(0.25);
  // strip: left edge north, horizon 100/128 of the way down, nothing past the top edge
  expect(dirToUV('strip', [0, 0, -1], 256, 128)).toEqual([0, 1 - DOOM_SKY.below / (1 + DOOM_SKY.below)]);
  expect(STRIP_HORIZON * 128).toBeCloseTo(100);
  expect(dirToUV('strip', [0, 1, -1], 256, 128)).toBeNull();
  // module.txt words, as server/src/sky.hpp reads them
  const p = { repeat: 4, height: 0.625, yaw: 0 };
  expect(skyLine('default', 'strip', 'SKY4', p)).toBe('sky default strip SKY4');
  expect(skyLine('map12', 'strip', 'SKY4', { repeat: 1, height: 0.8, yaw: 0.25 })).toBe('sky map12 strip SKY4 repeat 1 height 0.8 yaw 0.25');
  expect(skyLine('arena', 'cube', 'dusk', p)).toBe('sky arena cube dusk_east dusk_west dusk_north dusk_south dusk_up dusk_down');
  expect(setSkyLine('name x\nsky default strip SKY1\nsky map12 strip SKY2\n', 'sky map12 panorama p'))
    .toBe('name x\nsky default strip SKY1\nsky map12 panorama p\n');
  expect(setSkyLine('name x\nsky default strip SKY1\n', 'sky arena panorama p')).toBe('name x\nsky default strip SKY1\nsky arena panorama p\n');

  // the engine's own skyUv, where its source is on this machine
  const engine = '~/DoomNetPlatformer/engine/client/src/render/sky.js';
  const mod = await import(/* @vite-ignore */ engine).catch(() => null);
  if (!mod) return;
  const { skyUv, SKY_KIND } = mod;
  let compared = 0;
  const dirs: [number, number, number][] = [];
  for (let i = 0; i < 200; i++) dirs.push([Math.sin(i * 1.3), Math.sin(i * 0.7) * 0.9, Math.cos(i * 1.3)]);
  for (const prm of [{ repeat: 4, height: 0.625, yaw: 0 }, { repeat: 1, height: 1.2, yaw: 0.3 }, { repeat: 2.5, height: 0.5, yaw: -0.125 }])
    for (const d of dirs) {
      const [eu, ev] = skyUv({ kind: SKY_KIND.STRIP, ...prm }, d), mine = dirToUV('strip', d, 256, 128, prm);
      if (ev > 0 && ev < 1) { // inside the picture (the engine clamps to the caps outside)
        expect(mine![0]).toBeCloseTo(eu - Math.floor(eu), 9); // the engine repeats the texture; same place in the picture
        expect(1 - mine![1]).toBeCloseTo(ev, 9);
      }
      const [pu, pv] = skyUv({ kind: SKY_KIND.PANORAMA, ...prm }, d), pm = dirToUV('panorama', d, 64, 32, prm)!;
      expect(pm[0]).toBeCloseTo(pu - Math.floor(pu), 9);
      expect(1 - pm[1]).toBeCloseTo(pv, 9);
      compared++;
    }
  expect(compared).toBe(600); // the engine's code really was compared
});
