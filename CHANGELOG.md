# Changelog

What changed in each release of qPainter, fixes first. Kept as fixes land:
anything not released yet is under **Unreleased**.

## Unreleased

### Fixed

- **Inside another app on a phone, exporting and importing did nothing**
  (a palette, a PNG, an image to trace): a page in a frame cannot download or
  open a file picker there. The embed API has onSave(fn) and onOpen(fn), and
  the host's own save and file picker are used instead (the studio's system
  dialogs).

### Added

- **Every slider has a number box beside it** (size, hardness, opacity, the
  pattern's offsets and density, tolerance, noise, a layer's opacity): it shows
  the value, and a value typed in moves the slider, kept to its step and limits.

## 0.2.0 -- 2026-10-17

### Fixed

- **The palette jumped up and down when you changed tools.** The tool's
  options came first in the side panel, and each tool has a different number
  of them. The palette is now at the top of the panel and stays in place. The
  tool's options follow under the tool's name.
- **The Skybox list in the 3D preview ran past the panel's right edge**, so
  its choices were cut off. It now fits the panel.

### Changed

- **Tool icons are flat drawings in the interface's own colour.** Colour emoji
  (pencil, brush, eraser, bucket, droplet) no longer sit beside flat glyphs.
  The icons follow the light and dark themes and the Studio's styles. The play
  button and the pattern warning never turn into emoji either.
- **The top bar shows a control only when it applies.** **Tiles** appears
  while Wrap is on, **⊕** (the symmetry centre) while a symmetry is on, and
  **snap nearest / dither** while Lock is on.
- The Eyedropper's options now say how it picks: click for the primary colour,
  right-click for the secondary, or hold Alt with any other tool.

## 0.1.0 -- 2026-10-14

The first public release.
