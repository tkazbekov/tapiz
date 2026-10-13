import {
  BoardTemplateData,
  Point,
  TuNode,
  nodeBounds,
  nodesById,
  resolveArrowGeometry,
} from '@tapiz/board-commons';
import { defaultNoteColor } from '../note';

export type ThumbnailShape =
  | {
      kind: 'panel' | 'note' | 'text' | 'other';
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number };

export interface Thumbnail {
  viewBox: string;
  shapes: ThumbnailShape[];
}

/**
 * Plain rects for a template preview: panels outlined, notes filled with
 * their colour, text as grey bars, arrows as lines.
 */
export function templateThumbnail(data: BoardTemplateData): Thumbnail {
  const nodes: TuNode[] = data.nodes.map((node) => ({
    id: node.ref,
    type: node.type,
    content: node.content,
  }));
  const byId = nodesById(nodes);
  const width = Math.max(data.size.width, 1);
  const height = Math.max(data.size.height, 1);
  // a text bar is one line of a 300x180 card at most
  const bar = Math.max(width / 300, height / 180) * 6;

  const shapes = nodes.flatMap((node): ThumbnailShape[] => {
    const rect = nodeBounds(node, byId);

    if (!rect) {
      return [];
    }

    if (node.type === 'arrow') {
      // attached ends follow their nodes, the stored points may be stale
      const geometry = resolveArrowGeometry(node, byId);
      const content = node.content as { start?: Point; end?: Point };
      const start = geometry?.start ?? content.start ?? { x: 0, y: 0 };
      const end = geometry?.end ??
        content.end ?? { x: rect.width, y: rect.height };

      return [
        {
          kind: 'line',
          x1: rect.x + start.x,
          y1: rect.y + start.y,
          x2: rect.x + end.x,
          y2: rect.y + end.y,
        },
      ];
    }

    if (node.type === 'note') {
      const color = (node.content as { color?: string | null }).color;

      return [{ kind: 'note', ...rect, fill: color || defaultNoteColor }];
    }

    if (node.type === 'text') {
      return [{ kind: 'text', ...rect, height: Math.min(rect.height, bar) }];
    }

    return [{ kind: node.type === 'panel' ? 'panel' : 'other', ...rect }];
  });

  return { viewBox: `0 0 ${width} ${height}`, shapes };
}
