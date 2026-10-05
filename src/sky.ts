// Skies, exactly as the DoomNet Platformer engine draws them (its docs/SKY.md, client/src/render/sky.js):
//
//   strip     DOOM's sky: one picture wrapped round the horizon `repeat` times, left edge at north,
//             running clockwise; its top edge at the elevation whose tangent is `height`, the horizon
//             100/128 of the way down.
//   panorama  one equirectangular 2:1 picture: centre column north, east at 3/4, west at 1/4.
//   cube      six square pictures, edited here as the engine's own cross:
//                     [ UP ]
//             [EAST][SOUTH][WEST][NORTH]
//                     [DOWN]
//             each side upright as seen from inside facing it; up's bottom edge meets south's top.
//
// Directions use three.js's frame, as the engine's shader does: y up, north = -z, east = +x, south = +z.
// Texture coordinates here are (u, v) in [0,1], v = 0 at the top row (the engine's v = 1).

export type SkyKind = 'strip' | 'panorama' | 'cube';
export type SkyParams = { repeat: number; height: number; yaw: number };
type Vec3 = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number };
export type PixelMap = (x: number, y: number, ox: number, oy: number) => [number, number] | null;

/** DOOM's strip: a 256-wide picture 4 times round, top edge at tan = 100/160, bottom at -28/160 (engine DOOM_SKY). */
export const DOOM_SKY = { repeat: 4, height: 0.625, below: 0.28 };
export const SKY_DEFAULTS: SkyParams = { repeat: DOOM_SKY.repeat, height: DOOM_SKY.height, yaw: 0 };

export const SKY_KINDS: Record<SkyKind, string> = {
  strip: 'Strip — DOOM sky round the horizon',
  panorama: 'Panorama — equirectangular 2:1',
  cube: 'Cube — six faces (edited as a cross)',
};

/**
 * The six faces, in cubemap slot order (+x -x +y -y +z -z of three.js's frame, sampled with x flipped,
 * as the engine and three.js do): which compass direction each one shows.
 */
export const FACES = ['west', 'east', 'up', 'down', 'south', 'north'] as const;
/** Face indices in the order of the engine's `cube <E> <W> <N> <S> <UP> <DOWN>`. */
export const ENGINE_FACE_ORDER = [1, 0, 5, 4, 2, 3];
/** three.js file names for each face (docs/SKY.md: `cube <nx> <px> <nz> <pz> <py> <ny>`). */
export const THREE_FACE_NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
// The engine's cross, in face units: east south west north across the middle, up and down around south.
const CROSS: [number, number][] = [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [3, 1]];

/** Texture size for a new sky: `n` is the face size for a cube, the width otherwise. */
export function skySize(k: SkyKind, n: number): [number, number] {
  return k === 'cube' ? [4 * n, 3 * n] : [n, n / 2];
}
/** A cube must be a 4×3 cross of square faces; strips and panoramas take any size. */
export const fitsSky = (k: SkyKind, w: number, h: number) => k !== 'cube' || (w % 4 === 0 && w / 4 === h / 3);

/** Face rectangles in pixels (cube only), in FACES order. */
export function faceRects(k: SkyKind | null, w: number): Rect[] {
  if (k !== 'cube') return [];
  const f = w / 4;
  return CROSS.map(([c, r]) => ({ x: c * f, y: r * f, w: f, h: f }));
}

// ---------- cube directions (GL cubemap convention) ----------

/** Direction for face `f` at face coords s, t in [-1,1] (t down). Works beyond ±1 too: the face plane extended. */
export function faceDir(f: number, s: number, t: number): Vec3 {
  return ([[1, -t, -s], [-1, -t, s], [s, 1, t], [s, -1, -t], [s, -t, 1], [-s, -t, -1]] as Vec3[])[f];
}
/** Face and face coords (s, t in [-1,1]) hit by direction d. */
export function dirFace([x, y, z]: Vec3): [number, number, number] {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  if (ay >= az) return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

/**
 * Texture (u, v) seen looking in direction d, or null where the picture isn't (above/below a strip,
 * where the engine fades into its cap colours). The engine's skyUv / skyColour, mirrored by the
 * shader in preview3d.ts.
 */
export function dirToUV(k: SkyKind, [x, y, z]: Vec3, w: number, h: number, p: SkyParams = SKY_DEFAULTS): [number, number] | null {
  const a = p.yaw * Math.PI * 2;
  const rx = x * Math.cos(a) - z * Math.sin(a), rz = x * Math.sin(a) + z * Math.cos(a);
  const fract = (v: number) => v - Math.floor(v);
  const turn = Math.atan2(rx, -rz) / (Math.PI * 2);
  if (k === 'cube') {
    const [f, s, t] = dirFace([-rx, y, rz]), r = faceRects(k, w)[f];
    return [(r.x + ((s + 1) / 2) * r.w) / w, (r.y + ((t + 1) / 2) * r.h) / h];
  }
  if (k === 'panorama') return [fract(turn + 0.5), 0.5 - Math.asin(Math.max(-1, Math.min(1, y / (Math.hypot(rx, y, rz) || 1)))) / Math.PI];
  const t = y / Math.max(Math.hypot(rx, rz), 1e-4), bottom = -p.height * DOOM_SKY.below;
  const up = (t - bottom) / (p.height - bottom);
  return up < 0 || up > 1 ? null : [fract(turn * p.repeat), 1 - up];
}

/** Where a strip's horizon is, as a fraction of the picture's height from the top. */
export const STRIP_HORIZON = 1 / (1 + DOOM_SKY.below);

// ---------- 2D painting ----------

/**
 * Where pixel (x, y) really lands when painting a sky, for a brush stamped at (ox, oy):
 * - cube: pixels past the edge of the stamp's face continue onto the face that's next to it on
 *   the cube (the face plane is extended and projected); pixels outside every face are dropped;
 * - panorama: wraps left/right, and over a pole to the opposite side;
 * - strip: wraps left/right (copies round the horizon meet edge to edge); nothing above or below.
 */
export function skyMap(k: SkyKind, w: number, h: number): PixelMap {
  if (k !== 'cube')
    return (x, y) => {
      if (y < 0 || y >= h) {
        if (k === 'strip') return null;
        y = y < 0 ? -y - 1 : 2 * h - y - 1;
        x += w / 2;
      }
      return [((x % w) + w) % w, y];
    };
  const rects = faceRects(k, w);
  const faceAt = (x: number, y: number) => rects.findIndex((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
  return (x, y, ox, oy) => {
    const home = faceAt(ox, oy), here = faceAt(x, y);
    if (home < 0 || here === home) return here < 0 ? null : [x, y];
    const r = rects[home];
    const [f, s, tt] = dirFace(faceDir(home, ((x + 0.5 - r.x) / r.w) * 2 - 1, ((y + 0.5 - r.y) / r.h) * 2 - 1));
    const q = rects[f], clampPx = (v: number, lo: number, n: number) => Math.min(lo + n - 1, Math.max(lo, Math.floor(v)));
    return [clampPx(q.x + ((s + 1) / 2) * q.w, q.x, q.w), clampPx(q.y + ((tt + 1) / 2) * q.h, q.y, q.h)];
  };
}

// ---------- the engine's module.txt ----------

/** A texture name the engine accepts (server/src/sky.hpp sky_image_ok). */
export const engineName = (n: string) => n.replace(/\.png$/i, '').replace(/[^A-Za-z0-9_\-./]/g, '_').replace(/\.\.+/g, '.').slice(0, 64) || 'sky';
/** Picture names for a sky called `base`: one, or six for a cube in FACES order. */
export const skyPictures = (k: SkyKind, base: string) => (k === 'cube' ? FACES.map((f) => `${base}_${f}`) : [base]);

const num = (v: number) => String(Math.round(v * 1000) / 1000);
/** The `sky <level> ...` line, settings only where they differ from the engine's defaults. */
export function skyLine(level: string, k: SkyKind, base: string, p: SkyParams): string {
  const pics = skyPictures(k, base);
  const words = ['sky', level, k, ...(k === 'cube' ? ENGINE_FACE_ORDER.map((i) => pics[i]) : pics)];
  if (k === 'strip' && p.repeat !== DOOM_SKY.repeat) words.push('repeat', num(p.repeat));
  if (k === 'strip' && p.height !== DOOM_SKY.height) words.push('height', num(p.height));
  if (p.yaw) words.push('yaw', num(p.yaw));
  return words.join(' ');
}

/** module.txt with `line` replacing the sky line for the same level, or added after the last sky line (or at the end). */
export function setSkyLine(moduleTxt: string, line: string): string {
  const level = line.split(/\s+/)[1];
  const lines = moduleTxt.replace(/\n$/, '').split('\n');
  const same = lines.findIndex((l) => l.trim().split(/\s+/)[0] === 'sky' && l.trim().split(/\s+/)[1] === level);
  if (same >= 0) lines[same] = line;
  else {
    let last = -1;
    lines.forEach((l, i) => { if (l.trim().split(/\s+/)[0] === 'sky') last = i; });
    if (last >= 0) lines.splice(last + 1, 0, line);
    else lines.push('', '# The sky (docs/SKY.md), painted in qPainter.', line);
  }
  return lines.join('\n') + '\n';
}
