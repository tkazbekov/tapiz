import type { TuNode } from '../models/node.model.js';
import type { Point } from '../models/point.model.js';
import { boundsOfNodes } from './geometry.js';
import type {
  BoardTemplateData,
  BoardTemplateNode,
  TemplateNodeType,
} from './template-format.js';

export type LegacyTemplateNode = TuNode<
  Record<string, unknown> & { position: Point; layer?: number }
>;

/**
 * Adapts the web's built-in template files (absolute positions, blank ids)
 * to template data: refs n0.., coordinates from the bounding box top-left,
 * array order kept as the z-order.
 */
export function fromLegacyTemplate(
  nodes: LegacyTemplateNode[],
): BoardTemplateData {
  const bounds = boundsOfNodes(nodes) ?? { x: 0, y: 0, width: 0, height: 0 };

  return {
    version: 1,
    size: { width: bounds.width, height: bounds.height },
    nodes: nodes.map((node, index): BoardTemplateNode => ({
      ref: `n${index}`,
      // the schema rejects types a template can't hold
      type: node.type as TemplateNodeType,
      content: {
        ...node.content,
        position: {
          x: node.content.position.x - bounds.x,
          y: node.content.position.y - bounds.y,
        },
        layer: node.content.layer === 1 ? 1 : 0,
      },
    })),
  };
}
