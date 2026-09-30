# Integration brief: shared palettes, light preview and module handoff

**For:** the agent working on qPainter in this folder.
**From:** the Digidream toolbox plan, 2026-09-30.
**Status:** not started. Read this whole file before writing any code.

> This folder is **not a git repository**, so nothing you change here can be
> undone. Before your first edit, ask the user whether to `git init` and
> commit the current state as a baseline.

## Why

Digidream's art comes from three tools: qPainter for textures, ThreeSprite for
sprites, and the studio for levels. Each one keeps its own palettes, so over
time the walls and sprites drift into two different looks. This brief ties
them to **one palette per game module**. It also shows a texture the way the
engine will light it, and lets qPainter deliver textures into a module without
a download-and-import round trip. The contract below is shared word for word
with the other two tools. The sections after it are qPainter's part.

## The shared contract (identical in all three briefs)

> This section is copied word for word into `ThreeSprite/INTEGRATION.md`,
> `textureeditor/INTEGRATION.md` and `DoomNetPlatformer/studio/INTEGRATION.md`.
> The three tools live in separate repositories and nothing enforces the copy.
> If you believe the contract is wrong, do not change it on your own: stop,
> say what and why to the user, and let them change all three copies.
> Everything outside this section is yours to adapt.

### C1. Who is involved

| Tool | Where | Makes | Pixels are |
|---|---|---|---|
| **ThreeSprite** (PrSpr editor) | `~/ThreeSprite` | animated billboard sprites → `threesprite-atlas` v1 (`NAME.json` + `NAME.png`) | RGBA8, palettes are a drawing aid |
| **qPainter** | `~/textureeditor` | wall and floor textures → PNG | RGBA8, palette + optional lock |
| **Studio** | `~/DoomNetPlatformer/studio` | levels; owns the **module** the other two deliver into | — |

A **module** is a folder with a `module.txt` at its root (for example
`DoomNetPlatformer/modules/starter/`). The engine reads art from:

- `assets/textures/NAME.png`: walls and floors, one namespace. Sizes and
  cutout flags are in `assets/textures/index.json`:
  `{"sizes":{"NAME":[w,h]}, "cutout":{"NAME":true}}`.
- `assets/sprites/NAME.json` + `assets/sprites/NAME.png`: ThreeSprite atlases,
  `"format":"threesprite-atlas"`.
- **new:** `assets/palette.json`: the module palette (C2).

`NAME` is `[A-Z0-9_]{1,24}` for textures and sheets, which is the studio's
rule (`studio/src/main.js` `importTexture`, `studio/src/sheets.js`
`sheetName`). Tools uppercase and strip names to fit, and they show the result
before writing anything.

### C2. The palette file

One palette per module, at `assets/palette.json`. The engine never reads it.
It is a design-time file that travels with the module so that every tool paints
from the same colours.

```json
{
  "format": "digidream-palette",
  "version": 1,
  "name": "Starter",
  "colors": ["#000000", "#1d2b53", "#7e2553", "#008751"],
  "ramps": [
    { "name": "moss", "indices": [0, 3] }
  ]
}
```

- `colors`: 1 to 256 entries, each `#rrggbb`, lowercase on write. Reads are
  case-insensitive. Entries are opaque, and there are no duplicates; a reader
  that meets a duplicate keeps the first one and warns. Transparency is never
  a palette entry. It is alpha 0 in the pixels.
- `ramps`: optional. Each ramp is a named list of indices into `colors`,
  ordered dark to light. An index out of range makes the file invalid.
- **Unknown top-level keys are preserved** on every rewrite. A tool that
  rewrites the file reads it, changes only what it owns, and writes back
  everything else.
- `version` greater than 1: open read-only, say so, never write it.
- Writing: 2-space indent, trailing newline, keys in the order shown. That
  keeps diffs small under git.
- Tools can still import `.gpl`, `.hex` and `.pal`. `digidream-palette` is the
  exchange format, not a replacement for those.

### C3. A pixel that conforms

A pixel **conforms** to a palette when its alpha is 0, or when its alpha is 255
and its RGB equals one of `colors` exactly. Conformance is **advice, never a
gate**: the engine draws any RGBA. Tools report non-conforming pixels (a count,
plus a way to see them) and offer to snap them. They never refuse to save or
export because of them.

**Snapping** a colour means taking the palette entry with the smallest squared
RGB distance, `dr² + dg² + db²`, with ties going to the lower index. Alpha
becomes 0 if it is below 128, otherwise 255. This is the one nearest-colour rule
for all tools, so the same image snaps to the same result everywhere.

### C4. Linking and palette changes

A tool **links** a document or project to a module palette by keeping a
**snapshot**, which is the whole palette file as it was last read, inside its
own document. (Where that goes in each tool's format is covered in its own
brief.) The link also records the module id and the path
`assets/palette.json`. The actual file handle or URI is platform state, stored
wherever the tool keeps such things, never in the document.

When the tool sees that the file differs from the snapshot (on open, and when
the window regains focus; nothing watches files), it works out a **palette
change**. Call the old snapshot colours `S` and the new ones `N`. For each index
`i` of `S`:

1. `S[i]` is in `N` at any index → **kept**. No pixel changes, even if the
   colour moved. (Pixels are RGBA, so a reorder alone changes nothing.)
2. Otherwise, `i < len(N)` and `N[i]` is not in `S` → **recoloured**: pixels
   exactly `S[i]` become `N[i]`. This is the "I edited swatch 5" case.
3. Otherwise → **removed**: pixels exactly `S[i]` snap to `N` (C3).

Colours in `N` that are not in `S` and weren't used by rule 2 are **added**,
and no pixels change for them. The tool shows a summary before touching any
pixels (for example, "2 recoloured, 1 removed, 3 added — 1,204 pixels in 6
images change") and applies it as **one undo step**, or leaves the pixels alone
and just updates the snapshot, whichever the user picks. It never applies the
change silently.

Test vectors, which each implementation must pass:

| S | N | result |
|---|---|---|
| `[a,b,c]` | `[a,b,c]` | nothing |
| `[a,b,c]` | `[c,a,b]` | all kept, no pixel changes |
| `[a,b,c]` | `[a,x,c]` | `b→x` recoloured |
| `[a,b,c]` | `[a,b,c,d]` | `d` added |
| `[a,b,c]` | `[a,c]` | `b` removed → snaps to nearest of `{a,c}` |
| `[a,b,c]` | `[a,c,x]` | `b` removed (N[1]=c is in S), snaps to nearest of `{a,c,x}`; `x` added |
| `[a,b]` | `[b,a]` | all kept |

**Writing the module palette back**, for a tool that edits it: re-read the
file first. If it differs from the snapshot, **don't write**. Show both
versions and offer to reload (which runs the change above) before editing again.
After a successful write, the snapshot becomes what was written.

### C5. Handing art to a module

There are two channels, and every tool supports at least the second.

1. **Folder link** (desktop, and Chromium browsers through the File System
   Access API): the user picks a module folder, which has to contain
   `module.txt`. The tool reads `assets/palette.json` from it and exports
   straight into `assets/textures/` or `assets/sprites/`.
2. **Files** (everywhere, and the only channel on Android, where the studio's
   module tree is private to the game app): the tool saves a file, and the
   studio imports it through its existing import menu. The files are a PNG
   texture, a `.tsprite` or an atlas pair, or a `*.palette.json`.

A tool that writes into a module folder:

- writes only the files it owns: its own PNG and JSON under `assets/`, plus,
  for textures, a merge into `assets/textures/index.json` (qPainter brief);
- asks before overwriting an existing file of the same name, and shows what is
  there;
- never touches `maps/`, `scripts/`, `module.txt`, `module.studio.json` or
  `props.txt`.

A module that has a `module.studio.json` belongs to the studio. Files dropped
into it are picked up by the studio's **refresh from disk** (studio brief).
Until that exists, they may be overwritten by the studio's next Play or
Export, so the other tools say so after exporting into such a module.

### C6. What the engine does with light (so previews don't lie)

As of 2026-09-30, from `DoomNetPlatformer/client/src/render/lighting.js` and
`client/src/render/textures.js`:

- **Walls and floors**: `out = texel.rgb × lit`, where
  `lit = sector.light / 255` (0–255 per sector) plus additive point lights.
  Textures are loaded with `NoColorSpace`, so the multiply happens on the raw
  stored bytes. With no dynamic light in range, a byte `t` at light `L` shows
  as `round(t × L / 255)`. There is no palette, colormap or light ramp.
- **Sprites are drawn unlit** (`MeshBasicMaterial`), exactly as authored.

A light preview models the first rule and nothing more. If the engine changes
(colormaps, lit sprites), the previews change with it. They never invent their
own lighting.

---

## qPainter's part

### What is there today (verify; line numbers drift)

- `Doc` (`src/doc.ts`) holds `palette: RGBA[]`, `ramps: RGBA[][]`, `settings`
  (including `lock` and `snap: 'nearest'|'dither'`) and the layers, each of
  which is an `ImageData`. Pixels are RGBA.
- Every tool paints through `plot()` in `src/paint.ts`, which also applies the
  palette lock through `snap()`. Keep it that way: new behaviour goes through
  `plot()`/`snap()`, never around them.
- Palettes are handled in `src/palette.ts`: ramps (`hueShiftRamp`,
  `lerpRamp`), `.gpl` and `.hex` import and export, and remap by nearest,
  Bayer or Floyd–Steinberg.
- Files are handled in `src/io.ts`: the `.texproj.json` project format, the
  IndexedDB library (`textureeditor` v2), `pngBlob(doc, scale)`, File System
  Access handles on Chromium, SAF through
  `android/.../FilesPlugin.java` on Android, and downloads elsewhere.
- The 3D preview is `src/preview3d.ts`. Its lighting is fixed (ambient plus
  one directional, `MeshStandardMaterial`), and `lit` off switches it to
  `MeshBasicMaterial`.
- Tests: `npm test` runs vitest on `src/paint.test.ts`. `paint.ts` has no DOM,
  so keep new logic in DOM-free modules and test it there.

### Q1. Read and write `digidream-palette` (C2)

- Add it next to `.gpl` and `.hex` in `src/palette.ts` for both import and
  export, detecting it by the JSON `format` key.
- Ramps: qPainter's ramps are colour lists. The file stores indices. On read,
  turn indices into colours. On write, turn colours back into indices. A ramp
  colour that isn't in `colors` gets appended to the palette first, which is
  what qPainter already does when it makes a ramp.
- Tests, in a new DOM-free `src/palette_file.ts` plus
  `src/palette_file.test.ts`: parse, serialise, byte-identical round trip with
  unknown keys preserved, a duplicate colour, a ramp index out of range, and
  `version: 2` being read-only.

### Q2. Link a document to a module palette (C4)

- Add `paletteLink?: { module, path: 'assets/palette.json', snapshot }` to
  `Doc` and to `.texproj.json` as an optional field. Older projects load
  unchanged. The file handle goes in IndexedDB `kv`, the same way linked
  document files are kept today, never in the project.
- Linking: *Palette → Link to module palette…*, which picks a module folder
  where Q5 is available and a palette file everywhere else. Linking replaces
  `doc.palette` and `doc.ramps` with the file's. Before that, ask whether to
  remap existing pixels with one of the existing remap modes.
- Checks: on document open and on `visibilitychange` to visible, re-read the
  file. If it differs from the snapshot, run the C4 palette change over
  **every layer**, show the summary, and apply it as one structural undo
  step. qPainter has no exact recolour today. Write it as a pure function
  over `ImageData` (exact RGB match with alpha 255 → new RGB) and test it with
  the seven C4 vectors.
- Editing a linked palette locally marks it **diverged**. Diverged palettes
  get *Save to module* (C4 write-back, with its conflict check) and *Unlink*.
- With a linked palette, palette lock snaps to it, as it already does for
  `doc.palette`.

### Q3. Conformance check (C3)

- *Palette → Check*: a count of non-conforming pixels in the composite, and a
  toggle overlay that marks them. The overlay is view-only and never enters
  the document.
- *Snap to palette* reuses the existing remap with mode `nearest`. First
  check that its nearest rule and its alpha threshold match C3 exactly (for
  example, ties go to the lower index). If they don't, change them to match,
  since this is the one place all three tools must agree, and add a test.

### Q4. Light preview (C6)

- A **Light** slider from 0 to 255, defaulting to 255, with quick buttons at
  64, 128, 192 and 255. It affects display only: the 2D view, the 3×3 tile
  view and the 3D preview. Documents and exports are unchanged.
- 2D: each displayed byte `t` becomes `round(t × L / 255)`. Put that in a
  pure function with tests and apply it when drawing the composite, not to
  the layers.
- 3D: add an **Engine** lighting mode next to lit and unlit. It uses
  `MeshBasicMaterial` with `color` set to grey `L/255`, and a texture with
  `colorSpace = NoColorSpace` so the multiply happens on raw bytes, as it does
  in the engine. Check with a pixel read-back test, or by comparing a
  screenshot against the 2D result, that the two agree within ±1 per channel.
  If three.js colour management gets in the way, match the engine's result.
  Don't adjust the formula.
- A **strip** view shows the texture at five levels side by side, which makes
  it quick to see whether a texture still reads in a dark sector.
- Leave out distance falloff, point lights and colormaps. The engine doesn't
  do them for sector light, and the preview must not invent them (C6).

### Q5. Export to module (C5)

- *Export → To module…* takes a linked module folder, or asks for one.
- Name: `[A-Z0-9_]{1,24}`, taken from the document name, shown and editable
  before writing. If `assets/textures/NAME.png` already exists, show it next
  to the new one and ask before overwriting.
- It writes the composite at **1×** (the byte-exact path when there is a
  single layer at full opacity) to `assets/textures/NAME.png`.
- It merges into `assets/textures/index.json`. Read it, or start from
  `{"sizes":{},"cutout":{}}`, then set `sizes.NAME = [w, h]`. Set
  `cutout.NAME = true` if any pixel has alpha 0, and otherwise remove
  `cutout.NAME`. Keep every other key and entry, and write it with
  `JSON.stringify(x, null, 1)`, which is how the existing files are written.
- If `module.studio.json` exists, say after export that the studio has to
  refresh the module (C5). The studio regenerates `index.json` itself.
- Sizes: the engine repeats textures with `RepeatWrapping` on WebGL2, so any
  size works. Don't enforce powers of two. Warn about an odd size only if it
  isn't a multiple of 8, and only as a hint.
- Where channel 1 isn't available, *To module…* explains that and saves the
  PNG as today, for the studio to import.

### Q6. Folder access per platform

1. **Chromium desktop and PWA**: `showDirectoryPicker` in `readwrite` mode,
   keeping the handle in IndexedDB `kv` and asking for permission again after
   a reload.
2. **Android**: add `ACTION_OPEN_DOCUMENT_TREE` with
   `takePersistableUriPermission` to `FilesPlugin.java`, along with list,
   read and write calls under the tree. **Before building this, ask the user
   whether it's worth it.** The studio's own module tree on the phone is
   private to the game app, so this only helps for modules the user keeps in
   shared storage. The file channel may be enough. The user sideloads APKs and
   there is no adb, so every failure has to show on the phone screen: a
   status line or a dialog with the error text. A console log isn't enough.
3. **Firefox and Safari**: the file channel only.

### Out of scope

- A tiled export or other new export formats, and anything the engine would
  have to read.
- Changing how painting works, except where C3 forces the snap rule.
- Anything inside `DoomNetPlatformer` or `ThreeSprite`. If they need to
  change, write it down for the user.

### Done means

- `npm test` and `npm run build` pass. New logic is in DOM-free modules with
  tests, including the seven C4 vectors and the light formula.
- A manual end-to-end run in Chrome:
  1. Link `DoomNetPlatformer/modules/starter`.
  2. Paint.
  3. Edit `assets/palette.json` by hand.
  4. Switch tabs and back, and see the summary.
  5. Undo.
  6. Check the light strip.
  7. Export to the module and check that the PNG and the `index.json` merge
     are correct, with the other entries untouched.
- `./build-apk.sh` still builds.
- The README gets *Module palettes*, *Light preview* and *Export to module*
  sections next to the existing ones, and the shortcut table is updated if
  you add shortcuts. Update this brief's status line.
