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
