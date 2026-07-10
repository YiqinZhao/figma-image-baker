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
3. It'll prompt for an export scale (1x–4x, defaults to 2x) — pick something
   at least as high as the resolution you want the baked images to have,
   since this step fixes their pixel dimensions.
4. Each mask group in the selection gets replaced by a flat image node.
   `Cmd/Ctrl+Z` undoes the whole run in one step if you don't like the result.

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
