import type { TuNode } from '../models/node.model.js';
import type { Point } from '../models/point.model.js';
import {
  RUNTIME_NODE_TYPES,
  boundsOfNodes,
  nodesById,
  resolveArrowGeometry,
} from './geometry.js';
import {
  TEMPLATE_NODE_TYPES,
  isPortableAssetUrl,
  isTemplateRef,
  type BoardTemplateData,
  type BoardTemplateNode,
  type TemplateNodeType,
} from './template-format.js';

export type DropReason =
  'type_not_allowed' | 'masked_note' | 'board_scoped_asset';

export interface DroppedNode {
  id: string;
  type: string;
  reason: DropReason;
}

export interface TemplateFromNodesResult {
  data: BoardTemplateData;
  dropped: DroppedNode[];
  // arrows whose attachment pointed outside the template; they keep their endpoints
  detachedArrows: string[];
}

const ATTACHMENT_KEYS = ['startAttachment', 'endAttachment'] as const;

// board state that never belongs in a template
const STRIPPED_KEYS = [
  'votes',
  'emojis',
  'ownerId',
  'textHidden',
  'unLocked',
] as const;

const isTemplateType = (type: string): type is TemplateNodeType =>
  (TEMPLATE_NODE_TYPES as readonly string[]).includes(type);

function dropReason(
  node: TuNode,
  isMasked?: (node: TuNode) => boolean,
): DropReason | null {
  if (!isTemplateType(node.type)) {
    return 'type_not_allowed';
  }

  if (node.type === 'note' && isMasked?.(node)) {
    return 'masked_note';
  }

  if (node.type === 'image' || node.type === 'vector') {
    const url = (node.content as { url?: unknown }).url;

    if (typeof url !== 'string' || !isPortableAssetUrl(url)) {
      return 'board_scoped_asset';
    }
  }

  return null;
}

function assignRefs(nodes: TuNode[]): string[] {
  const used = new Set(nodes.map((node) => node.id).filter(isTemplateRef));
  const taken = new Set<string>();

  return nodes.map((node, index) => {
    if (isTemplateRef(node.id) && !taken.has(node.id)) {
      taken.add(node.id);
      return node.id;
    }

    let ref = `n${index}`;

    for (let i = 1; used.has(ref) || taken.has(ref); i++) {
      ref = `n${index}_${i}`;
    }

    taken.add(ref);
    return ref;
  });
}

/**
 * Turns selected board nodes into template data, in board order. `isMasked`
 * tells which notes the saving user can't read.
 */
export function templateFromNodes(
  selected: TuNode[],
  options: { boardNodes?: TuNode[]; isMasked?: (node: TuNode) => boolean } = {},
): TemplateFromNodesResult {
  const order = new Map(
    (options.boardNodes ?? []).map((node, index) => [node.id, index]),
  );
  const sorted = selected
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        (order.get(a.node.id) ?? Infinity) -
          (order.get(b.node.id) ?? Infinity) || a.index - b.index,
    )
    .map((it) => it.node);

  const dropped: DroppedNode[] = [];
  // runtime nodes (users, settings, timers) are never content: skipped
  // without a word, so dropped only lists what the user may expect saved
  const kept = sorted.filter((node) => {
    if (RUNTIME_NODE_TYPES.has(node.type)) {
      return false;
    }

    const reason = dropReason(node, options.isMasked);

    if (reason) {
      dropped.push({ id: node.id, type: node.type, reason });
    }

    return !reason;
  });

  const refs = assignRefs(kept);
  const refById = new Map(kept.map((node, index) => [node.id, refs[index]]));
  const byId = nodesById([...(options.boardNodes ?? []), ...selected]);
  // attached arrows keep where they render, not their stale stored geometry
  const resolved = kept.map((node) => ({
    ...node,
    content: {
      ...(node.content as Record<string, unknown>),
      ...resolveArrowGeometry(node, byId),
    },
  }));
  const bounds = boundsOfNodes(resolved) ?? { x: 0, y: 0, width: 0, height: 0 };
  const detachedArrows: string[] = [];

  const nodes = resolved.map((node, index): BoardTemplateNode => {
    const content: Record<string, unknown> = { ...node.content };

    STRIPPED_KEYS.forEach((key) => delete content[key]);

    if (node.type === 'note') {
      Object.assign(content, { votes: [], emojis: [], ownerId: '' });
    }

    if (node.type === 'arrow') {
      ATTACHMENT_KEYS.forEach((key) => {
        const attachment = content[key] as
          { nodeId: string; offset: Point } | undefined;

        if (!attachment) {
          return;
        }

        const ref = refById.get(attachment.nodeId);

        if (ref) {
          content[key] = { ...attachment, nodeId: ref };
        } else {
          delete content[key];

          if (!detachedArrows.includes(node.id)) {
            detachedArrows.push(node.id);
          }
        }
      });
    }

    const position = content['position'] as Point;

    return {
      ref: refs[index],
      type: node.type as TemplateNodeType,
      content: {
        ...content,
        // a node without a position is left for the schema to reject
        position: position
          ? { x: position.x - bounds.x, y: position.y - bounds.y }
          : position,
        layer: content['layer'] === 1 ? 1 : 0,
      },
    };
  });

  return {
    data: {
      version: 1,
      size: { width: bounds.width, height: bounds.height },
      nodes,
    },
    dropped,
    detachedArrows,
  };
}
