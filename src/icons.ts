// The tool bar's icons: flat, one colour (currentColor), drawn on a 16-unit grid.
// No emoji anywhere in the UI: they sit on their own baseline and change with the OS.
// Pixel details (dither, scatter, anti-alias steps) are squares, as they are on the canvas.

const px = (cells: [number, number][], s = 2, extra = '') =>
  cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="${s}" height="${s}"${extra}/>`).join('');
const checker = (x0: number, y0: number, n: number, s: number) => {
  const c: [number, number][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i + j) % 2 === 0) c.push([x0 + i * s, y0 + j * s]);
  return c;
};

const ICONS: Record<string, string> = {
  pencil: '<path d="M11 2.5 13.5 5l-8 8-3 .5.5-3z"/><path d="m9.5 4 2.5 2.5"/>',
  brush: '<path d="m14 2-5.5 5.5"/><path d="m7.2 6.4 2.4 2.4"/>' +
    '<path d="M7 7.6c-1.9-.4-3.6.8-3.8 2.7-.2 1.6-.9 2.6-1.7 3.2 2.5.6 5.4.2 6.5-1.8.7-1.4.4-2.9-1-4.1z" fill="currentColor" stroke="none"/>',
  eraser: '<path d="M2.6 10.4 8.4 4.6a1.2 1.2 0 0 1 1.7 0l2.8 2.8a1.2 1.2 0 0 1 0 1.7L8.5 13.5H5.7z"/><path d="m5.4 7.6 4.5 4.5"/><path d="M8.5 13.5h5"/>',
  dither: `<rect x="2" y="2" width="12" height="12" rx=".5"/><g fill="currentColor" stroke="none">${px(checker(2, 2, 4, 3), 3)}</g>`,
  shade: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor"/>',
  noise: `<g fill="currentColor" stroke="none">${px([[2, 3], [8, 2], [12, 6], [5, 7], [10, 10], [2, 12], [13, 13], [7, 13]])}</g>`,
  replace: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
  // a staircase edge with the in-between pixels a pixel artist adds by hand
  smooth: `<path d="M2 14h3v-3h3V8h3V5h3V2"/><g fill="currentColor" stroke="none" opacity=".5">${px([[5, 12.2], [8, 9.2], [11, 6.2]], 1.8)}</g>`,
  line: `<path d="m4 12 8-8"/><g fill="currentColor" stroke="none">${px([[2, 12], [12, 2]], 2.4)}</g>`,
  rect: '<rect x="2.5" y="4" width="11" height="8" rx=".5"/>',
  ellipse: '<ellipse cx="8" cy="8" rx="5.75" ry="4.5"/>',
  // a bucket tipped over, paint up to its rim, a drop falling from the lip
  fill: '<path d="M6.5 3 12 8.5l-4.6 4.6a1.3 1.3 0 0 1-1.8 0L1.9 9.4a1.3 1.3 0 0 1 0-1.8z"/>' +
    '<path d="M1.6 8.5H12L7.4 13.1a1.3 1.3 0 0 1-1.8 0L1.9 9.4z" fill="currentColor" stroke="none"/><path d="M5.2 1.6 3.8 3a2.4 2.4 0 0 0 0 3.4"/>' +
    '<path d="M13.6 9.6c.8 1.1 1.3 1.9 1.3 2.6a1.3 1.3 0 0 1-2.6 0c0-.7.5-1.5 1.3-2.6z" fill="currentColor" stroke="none"/>',
  // a dithered ramp, wider than tall: solid, then half, then sparse
  gradient: `<rect x="2" y="4" width="12" height="8" rx=".5"/><g fill="currentColor" stroke="none">` +
    `<rect x="2" y="4" width="4" height="8"/>${px([[6, 4], [8, 6], [6, 8], [8, 10], [10, 4], [12, 8]])}</g>`,
  picker: '<path d="M9.4 4.1 10.8 2.7a1.9 1.9 0 0 1 2.6 2.6L12 6.6"/><path d="m8.4 3.4 4.2 4.2"/>' +
    '<path d="M10.5 5.5 4.3 11.7l-.3 1.9-1.5 1.4M4 13.6l1.9-.3 6.2-6.2"/>',
  select: '<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2.2 1.6"/>',
  move: '<path d="M8 1.5v13M1.5 8h13"/><path d="M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/>',
};

/** The tool's icon as an inline SVG, sized by CSS (`#tools svg`). */
export function toolIcon(id: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id] ?? ''}</svg>`;
}
