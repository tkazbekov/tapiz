import type { TemplatePreviewRect } from '@tapiz/board-commons';
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
 * Plain shapes for a template preview, from the outline the template list
 * returns: panels outlined, notes filled with their colour, text as grey
 * bars, arrows as lines from their start to their end.
 */
export function templateThumbnail(
  preview: TemplatePreviewRect[],
  size: { width: number; height: number },
): Thumbnail {
  const width = Math.max(size.width, 1);
  const height = Math.max(size.height, 1);
  // a text bar is one line of a 300x180 card at most
  const bar = Math.max(width / 300, height / 180) * 6;

  const shapes = preview.map((rect): ThumbnailShape => {
    const { type, x, y } = rect;

    if (type === 'arrow') {
      return {
        kind: 'line',
        x1: x,
        y1: y,
        x2: x + rect.width,
        y2: y + rect.height,
      };
    }

    const box = { x, y, width: rect.width, height: rect.height };

    if (type === 'note') {
      return { kind: 'note', ...box, fill: rect.fill || defaultNoteColor };
    }

    if (type === 'text') {
      return { kind: 'text', ...box, height: Math.min(box.height, bar) };
    }

    return { kind: type === 'panel' ? 'panel' : 'other', ...box };
  });

  return { viewBox: `0 0 ${width} ${height}`, shapes };
}
