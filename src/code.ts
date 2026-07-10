/// <reference types="@figma/plugin-typings" />

// Node types we're willing to export-and-replace in place. Component/instance
// nodes are deliberately excluded: replacing their internals could desync
// them from the main component in surprising ways.
const BAKEABLE_TYPES = new Set<NodeType>(["GROUP", "FRAME", "BOOLEAN_OPERATION", "SECTION"]);

// Figma's exportAsync rejects SCALE constraint values outside this range.
const MIN_EXPORT_SCALE = 0.01;
const MAX_EXPORT_SCALE = 4;

// Used when a masked group contains no raster image fill at all (pure vector
// content), since there's no "native resolution" to match in that case.
const FALLBACK_SCALE = 2;

type Bakeable = SceneNode & ChildrenMixin;
type ImageFillNode = SceneNode & LayoutMixin & MinimalFillsMixin;

function hasMaskChild(node: ChildrenMixin): boolean {
  return node.children.some((c) => "isMask" in c && (c as MinimalFillsMixin & { isMask?: boolean }).isMask === true);
}

function isBakeable(node: BaseNode): node is Bakeable {
  return BAKEABLE_TYPES.has(node.type as NodeType) && "children" in node;
}

/**
 * Walk the subtree under `root` and collect every container whose direct
 * children include a mask layer. We deliberately stop descending once we
 * find one — baking the whole container captures any masks nested inside it
 * too, since exportAsync renders final composited pixels, not raw geometry.
 * The root itself is never baked, even if it directly contains a mask,
 * so selecting a big frame doesn't flatten the entire frame into one image.
 */
function findMaskContainers(root: BaseNode): Bakeable[] {
  const results: Bakeable[] = [];

  function visit(node: BaseNode, isRoot: boolean): void {
    if (!("children" in node)) return;
    const container = node as ChildrenMixin;

    if (!isRoot && isBakeable(node) && hasMaskChild(container)) {
      results.push(node);
      return;
    }

    for (const child of container.children) {
      visit(child, false);
    }
  }

  visit(root, true);
  return results;
}

function collectImageFills(root: BaseNode): { node: ImageFillNode; paint: ImagePaint }[] {
  const found: { node: ImageFillNode; paint: ImagePaint }[] = [];

  function visit(node: BaseNode): void {
    if ("fills" in node) {
      const fills = (node as MinimalFillsMixin).fills;
      if (Array.isArray(fills)) {
        for (const paint of fills) {
          if (paint.type === "IMAGE" && paint.imageHash) {
            found.push({ node: node as ImageFillNode, paint });
          }
        }
      }
    }
    if ("children" in node) {
      for (const child of (node as ChildrenMixin).children) visit(child);
    }
  }

  visit(root);
  return found;
}

/**
 * Figures out what export scale would reproduce each image fill's native
 * pixel resolution, and returns the largest one found (so a container mixing
 * a hi-res photo with a small icon still samples the photo at full density).
 * For CROP-mode fills, factors in imageTransform's scale so a tight crop of a
 * large source image is recognized as needing higher density, not lower.
 */
async function computeNativeScale(container: Bakeable): Promise<number> {
  const imageFills = collectImageFills(container);
  if (imageFills.length === 0) return FALLBACK_SCALE;

  let maxRatio = 0;

  for (const { node, paint } of imageFills) {
    if (!paint.imageHash) continue;
    const image = figma.getImageByHash(paint.imageHash);
    if (!image) continue;

    try {
      const { width: nativeW, height: nativeH } = await image.getSizeAsync();
      let effW = nativeW;
      let effH = nativeH;

      if (paint.scaleMode === "CROP" && paint.imageTransform) {
        effW = nativeW * Math.abs(paint.imageTransform[0][0]);
        effH = nativeH * Math.abs(paint.imageTransform[1][1]);
      }

      if (node.width > 0 && node.height > 0) {
        maxRatio = Math.max(maxRatio, effW / node.width, effH / node.height);
      }
    } catch (err) {
      console.warn(`figma-image-baker: couldn't read native size for a fill in "${container.name}"`, err);
    }
  }

  return maxRatio > 0 ? maxRatio : FALLBACK_SCALE;
}

async function bakeContainer(node: Bakeable, userMultiplier: number): Promise<{ clamped: boolean }> {
  const parent = node.parent;
  if (!parent || !("insertChild" in parent)) {
    throw new Error(`"${node.name}" has no editable parent`);
  }

  const index = parent.children.indexOf(node);
  const { width, height, name, relativeTransform } = node;

  const nativeScale = await computeNativeScale(node);
  const requestedScale = nativeScale * userMultiplier;
  const scale = Math.min(Math.max(requestedScale, MIN_EXPORT_SCALE), MAX_EXPORT_SCALE);
  const clamped = requestedScale > MAX_EXPORT_SCALE;

  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });

  const image = figma.createImage(bytes);

  const rect = figma.createRectangle();
  rect.resize(width, height);
  rect.relativeTransform = relativeTransform;
  rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  rect.name = name;

  // Insert the replacement before removing the original so the parent is
  // never briefly empty (an empty Group node auto-deletes itself in Figma).
  (parent as unknown as ChildrenMixin & { insertChild(i: number, n: SceneNode): void }).insertChild(index, rect);
  node.remove();

  return { clamped };
}

function parseMultiplier(raw: string | undefined): number {
  const n = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

figma.parameters.on("input", ({ key, query, result }) => {
  if (key === "scale") {
    const suggestions = ["1", "0.5", "2", "4"].filter((s) => s.startsWith(query));
    result.setSuggestions(suggestions.length > 0 ? suggestions : ["1"]);
  }
});

figma.on("run", async ({ command, parameters }: RunEvent) => {
  if (command !== "bake-mask-groups") {
    figma.closePlugin();
    return;
  }

  const multiplier = parseMultiplier(parameters?.scale as string | undefined);
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.notify("Select a frame (or group) first.");
    figma.closePlugin();
    return;
  }

  const containers: Bakeable[] = [];
  for (const sel of selection) {
    containers.push(...findMaskContainers(sel));
  }

  if (containers.length === 0) {
    figma.notify("No mask groups found in the selection.");
    figma.closePlugin();
    return;
  }

  let baked = 0;
  let failed = 0;
  let clampedCount = 0;

  for (const container of containers) {
    try {
      const { clamped } = await bakeContainer(container, multiplier);
      baked++;
      if (clamped) clampedCount++;
    } catch (err) {
      failed++;
      console.error(`figma-image-baker: failed to bake "${container.name}"`, err);
    }
  }

  const parts = [`Baked ${baked} mask group(s)`];
  if (clampedCount > 0) parts.push(`${clampedCount} hit Figma's 4x export cap (source is higher-res than that)`);
  if (failed > 0) parts.push(`${failed} failed (see console)`);
  figma.notify(parts.join(", ") + ".");
  figma.closePlugin();
});
