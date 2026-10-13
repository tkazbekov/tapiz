import type { NodeAdd } from '../models/node.model.js';
import type { Point } from '../models/point.model.js';
import { boundsOfNodes, type Rect } from './geometry.js';
import type { BoardTemplateData } from './template-format.js';

// auto: admins keep the stored layers, everyone else gets layer 0
export type LayerPolicy = 'auto' | 'asStored';

export interface InstantiateOptions {
  origin: Point;
  newId: () => string;
  ownerId: string;
  isAdmin: boolean;
  layer?: LayerPolicy;
}

export interface InstantiateResult {
  actions: NodeAdd[];
  refToId: Record<string, string>;
  layerCoerced: boolean;
  bounds: Rect;
}

const ATTACHMENT_KEYS = ['startAttachment', 'endAttachment'] as const;

/**
 * Add actions for a parsed template placed at `origin`. Actions carry no
 * `position`; see assignInsertPositions.
 */
export function instantiateTemplate(
  template: BoardTemplateData,
  options: InstantiateOptions,
): InstantiateResult | { error: 'layer_admin_only' } {
  const policy = options.layer ?? 'auto';
  const hasFrames = template.nodes.some((node) => node.content.layer === 1);

  if (policy === 'asStored' && !options.isAdmin && hasFrames) {
    return { error: 'layer_admin_only' };
  }

  const coerce = !options.isAdmin;
  const refToId: Record<string, string> = Object.create(null);

  template.nodes.forEach((node) => {
    refToId[node.ref] = options.newId();
  });

  const actions = template.nodes.map((node): NodeAdd => {
    const content: Record<string, unknown> = structuredClone(node.content);
    const { position } = node.content;

    content['position'] = {
      x: options.origin.x + position.x,
      y: options.origin.y + position.y,
    };
    content['layer'] = coerce || node.content.layer !== 1 ? 0 : 1;

    delete content['unLocked'];

    if (node.type === 'note') {
      delete content['textHidden'];
      Object.assign(content, {
        ownerId: options.ownerId,
        votes: [],
        emojis: [],
      });
    }

    if (node.type === 'group') {
      content['votes'] = [];
    }

    if (node.type === 'arrow') {
      ATTACHMENT_KEYS.forEach((key) => {
        const attachment = content[key] as { nodeId: string } | undefined;

        if (!attachment) {
          return;
        }

        const id = refToId[attachment.nodeId];

        if (id) {
          content[key] = { ...attachment, nodeId: id };
        } else {
          delete content[key];
        }
      });
    }

    return {
      op: 'add',
      data: { id: refToId[node.ref], type: node.type, content },
    };
  });

  // the nodes, not the declared size, tell where the template lands
  const bounds = boundsOfNodes(actions.map((action) => action.data)) ?? {
    ...options.origin,
    width: 0,
    height: 0,
  };

  return {
    actions,
    refToId: { ...refToId },
    layerCoerced: coerce && hasFrames,
    bounds,
  };
}
