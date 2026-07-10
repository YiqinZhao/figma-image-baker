# figma-image-baker

A Figma plugin that finds every mask group and clipped-image frame inside
your selection and bakes each one into a single flat image, replacing the
mask/clip construct with one plain image node in the same position/size.

## Why

Figma's PDF exporter implements clipping/masking — both an explicit "Use as
Mask" layer *and* a plain frame with "Clip content" toggled on over raster
content — using PDF soft-mask (`ExtGState` + transparency `Group`)
constructs, even for plain rectangular crops. Some PDF pipelines (notably
arXiv's LaTeX-recompilation step) drop the `/Group` dictionary those soft
masks depend on when they merge/optimize included PDFs, which makes the
masked content render as fully transparent on macOS's Quartz/PDFKit renderer
(Safari, Preview, Quick Look) — even though it looks fine everywhere else.

Baking the mask/clip into the image's own pixels removes the dependency on
that soft-mask machinery entirely: the exported PDF just contains a plain
image XObject, which every renderer handles the same way. Text layers you
don't select are untouched, so labels/captions stay selectable.

Constructs this *doesn't* need to touch, because they're already robust PDF
features on their own: gradients (standard shading patterns), vector boolean
operations, single-layer opacity with no overlapping siblings (native
constant-alpha, no group needed), and drop shadows/blurs (Figma rasterizes
these itself already). Non-`NORMAL` blend modes (Multiply, Screen, etc.) rely
on the same fragile `Group`/`ExtGState` machinery too, but aren't auto-baked
yet — flag it if you hit one in practice.

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
   downsample. Figma caps any single exported image at 4096px on its longest
   side (silently downscaling if you ask for more) — there's no fixed "max
   scale", the effective ceiling just depends on how large the masked group
   is on the canvas. If a bake would exceed it, the plugin computes the
   largest scale that still fits and tells you it hit that ceiling.
4. Each mask group in the selection gets replaced by a flat image node.
   `Cmd/Ctrl+Z` undoes the whole run in one step if you don't like the result.

## How the resolution is picked

For each bake target, the plugin looks at every image fill inside it, reads
the fill's *native* pixel dimensions via the Figma API, and compares that to
how large the fill is actually drawn on the canvas. The largest ratio found
(accounting for `CROP`-mode fills, where `imageTransform` means only part of
the source image is visible) becomes that group's export scale, so the baked
PNG matches the highest-resolution source image involved rather than the
group's on-screen size. If a bake target has no raster fill at all (pure
vector content), it falls back to a flat 2x.

## How it decides what to bake

It walks the selection's descendants looking for either of two things:

- Any Group/Frame/Boolean/Section container whose direct children include a
  layer with `isMask` set (an explicit "Use as Mask").
- Any Frame with "Clip content" on, where at least one child's render bounds
  actually spill outside the frame (so it's really clipping something, not
  just toggled on unused) *and* it contains a raster image fill somewhere
  inside. Pure-vector clipped frames are left alone since a plain PDF clip
  path handles those fine on its own.

Once a container matches either condition, it stops descending into it —
exporting captures whatever's visually composited inside, including anything
nested further in — and exports the whole thing as PNG, then swaps it in for
the original mask/clip construct.

The selection itself is never baked outright even if it directly qualifies,
so running this on a large frame only flattens the individual sub-groups
inside it, not the whole frame.

Component instances are skipped on purpose — replacing their internals could
desync them from the main component in surprising ways. If you need one
baked, detach the instance first.
