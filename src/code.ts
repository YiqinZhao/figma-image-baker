/// <reference types="@figma/plugin-typings" />

// Node types we're willing to export-and-replace in place. Component/instance
// nodes are deliberately excluded: replacing their internals could desync
// them from the main component in surprising ways.
const BAKEABLE_TYPES = new Set<NodeType>(["GROUP", "FRAME", "BOOLEAN_OPERATION", "SECTION"]);

type Bakeable = SceneNode & ChildrenMixin;

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

async function bakeContainer(node: Bakeable, scale: number): Promise<void> {
  const parent = node.parent;
  if (!parent || !("insertChild" in parent)) {
    throw new Error(`"${node.name}" has no editable parent`);
  }

  const index = parent.children.indexOf(node);
  const { width, height, name, relativeTransform } = node;

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
}

function parseScale(raw: string | undefined): number {
  const n = raw ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 2;
  return Math.min(Math.max(n, 1), 4);
}

figma.parameters.on("input", ({ key, query, result }) => {
  if (key === "scale") {
    const suggestions = ["1", "2", "3", "4"].filter((s) => s.startsWith(query));
    result.setSuggestions(suggestions.length > 0 ? suggestions : ["2"]);
  }
});

figma.on("run", async ({ command, parameters }: RunEvent) => {
  if (command !== "bake-mask-groups") {
    figma.closePlugin();
    return;
  }

  const scale = parseScale(parameters?.scale as string | undefined);
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

  for (const container of containers) {
    try {
      await bakeContainer(container, scale);
      baked++;
    } catch (err) {
      failed++;
      console.error(`figma-image-baker: failed to bake "${container.name}"`, err);
    }
  }

  const summary = failed > 0 ? `Baked ${baked} mask group(s), ${failed} failed (see console).` : `Baked ${baked} mask group(s).`;
  figma.notify(summary);
  figma.closePlugin();
});
