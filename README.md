# figma-image-baker

A Figma plugin that finds every mask group inside your selection and bakes
each one into a single flat image, replacing the mask + masked layers with
one plain image node in the same position/size.

## Why

Figma's PDF exporter implements clipping/masking (frame "Clip content" or an
explicit "Use as Mask" layer) using PDF soft-mask (`ExtGState` + transparency
`Group`) constructs, even for plain rectangular crops. Some PDF pipelines
(notably arXiv's LaTeX-recompilation step) drop the `/Group` dictionary those
soft masks depend on when they merge/optimize included PDFs, which makes the
masked content render as fully transparent on macOS's Quartz/PDFKit renderer
(Safari, Preview, Quick Look) — even though it looks fine everywhere else.

Baking the mask into the image's own pixels removes the dependency on that
soft-mask machinery entirely: the exported PDF just contains a plain image
XObject, which every renderer handles the same way. Text layers you don't
select are untouched, so labels/captions stay selectable.

## Setup

```
npm install
npm run build
```

Then in the Figma desktop app: **Plugins → Development → Import plugin from
manifest…** and pick `manifest.json` in this repo.

Run `npm run watch` while developing to rebuild `code.js` on save.

## Use

1. Select a frame (or group) containing one or more masked images.
2. Right-click → **Plugins → Image Baker → Bake Mask Groups** (or find it via
   Quick Actions).
3. It'll prompt for an optional multiplier (default 1x). Leave it blank and
   each image is baked at its own **native source resolution** — e.g. a
   1024×1024 image cropped down to a 768×768 view bakes out at 768×768, not
   at whatever tiny size it happens to be displayed on the canvas. Bump the
   multiplier above 1 for extra headroom, or below 1 to intentionally
   downsample. Figma caps any single export at 4x the on-canvas size, so if a
   source image is scaled down enormously on the canvas, native resolution
   may not be fully reachable in one pass — the plugin tells you if a bake
   hit that ceiling.
4. Each mask group in the selection gets replaced by a flat image node.
   `Cmd/Ctrl+Z` undoes the whole run in one step if you don't like the result.

## How the resolution is picked

For each masked group, the plugin looks at every image fill inside it, reads
the fill's *native* pixel dimensions via the Figma API, and compares that to
how large the fill is actually drawn on the canvas. The largest ratio found
(accounting for `CROP`-mode fills, where `imageTransform` means only part of
the source image is visible) becomes that group's export scale, so the baked
PNG matches the highest-resolution source image involved rather than the
group's on-screen size. If a masked group has no raster fill at all (pure
vector content), it falls back to a flat 2x.

## How it decides what to bake

It walks the selection's descendants looking for any Group/Frame/Boolean
container whose direct children include a layer with `isMask` set. Once
found, it stops descending into that container — exporting it captures
whatever's visually composited inside, including any masks nested further
in — and exports the whole thing as PNG, then swaps it in for the original
mask construct.

The selection itself is never baked outright even if it directly contains a
mask, so running this on a large frame only flattens the individual masked
sub-groups inside it, not the whole frame.

Component instances are skipped on purpose — replacing their internals could
desync them from the main component in surprising ways. If you need one
baked, detach the instance first.
