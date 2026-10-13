import type { TuNode } from '../models/node.model.js';
import {
  intersectionArea,
  nodeBounds,
  nodesById,
  rectContains,
  rectsIntersect,
  type Rect,
} from './geometry.js';
import {
  estimateNoteFontPx,
  estimatePanelTextBottom,
  estimateTextNodeHeight,
} from './text-estimate.js';

export type LintCode =
  | 'layer_admin_only'
  | 'nonpositive_size'
  | 'text_overflow'
  | 'raw_heading'
  | 'note_text_too_long'
  | 'note_overlap'
  | 'note_in_header'
  | 'panel_color_recolors_notes'
  | 'overlaps_existing'
  | 'dangling_attachment';

/**
 * Advisory only: nothing here blocks a write. 'error' marks what the server
 * would reject or what never renders.
 */
export interface LintIssue {
  level: 'error' | 'warning';
  code: LintCode;
  nodeIds: string[];
  message: string;
  hint?: string;
}

export interface LintOptions {
  // only issues touching these nodes are reported (default: all)
  scopeIds?: string[];
  isAdmin?: boolean;
  // nodes that were on the board before the scoped ones were added
  existingIds?: string[];
}

interface Content {
  layer?: number;
  width?: number;
  height?: number;
  rotation?: number;
  text?: unknown;
  color?: unknown;
  startAttachment?: { nodeId: string };
  endAttachment?: { nodeId: string };
}

const OVERFLOW_RATIO = 1.1;
const MIN_NOTE_FONT = 18;
const NOTE_OVERLAP_RATIO = 0.15;
const HEADING_SIZES: Record<string, number> = { h1: 320, h2: 160, h3: 80 };
const HEADING_RE = /<(h[1-3])\b/i;
const FRAME_TYPES = new Set(['panel', 'group']);

const contentOf = (node: TuNode) => (node.content ?? {}) as Content;
const textOf = (node: TuNode) => {
  const text = contentOf(node).text;

  return typeof text === 'string' ? text : '';
};

interface Placed {
  node: TuNode;
  bounds: Rect;
}

export function lintNodes(
  nodes: TuNode[],
  options: LintOptions = {},
): LintIssue[] {
  const scope = options.scopeIds ? new Set(options.scopeIds) : null;
  const inScope = (node: TuNode) => !scope || scope.has(node.id);
  const existing = new Set(options.existingIds ?? []);
  const ids = new Set(nodes.map((node) => node.id));
  const issues: LintIssue[] = [];

  const byId = nodesById(nodes);
  const placed = nodes.flatMap((node): Placed[] => {
    const bounds = nodeBounds(node, byId);

    return bounds ? [{ node, bounds }] : [];
  });
  const unrotated = placed.filter((it) => !contentOf(it.node).rotation);
  const notes = unrotated.filter((it) => it.node.type === 'note');
  const panels = unrotated.filter((it) => it.node.type === 'panel');

  nodes.filter(inScope).forEach((node) => {
    const content = contentOf(node);
    const { width, height } = content;

    if (
      options.isAdmin === false &&
      content.layer === 1 &&
      !existing.has(node.id)
    ) {
      issues.push({
        level: 'error',
        code: 'layer_admin_only',
        nodeIds: [node.id],
        message: 'Only board admins can add or change layer 1 nodes',
        hint: 'Use layer 0',
      });
    }

    if (
      node.type !== 'arrow' &&
      ((typeof width === 'number' && width <= 0) ||
        (typeof height === 'number' && height <= 0))
    ) {
      issues.push({
        level: 'error',
        code: 'nonpositive_size',
        nodeIds: [node.id],
        message: `Size ${width}x${height} is not positive`,
      });
    }

    const text = textOf(node);
    const heading = text.match(HEADING_RE)?.[1].toLowerCase();

    if (heading) {
      issues.push({
        level: 'warning',
        code: 'raw_heading',
        nodeIds: [node.id],
        message: `<${heading}> renders at ${HEADING_SIZES[heading]}px`,
        hint: 'Use a text preset (title 64px, heading 40px, subheading 28px) instead of h1-h3',
      });
    }

    if (
      text &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      width > 0 &&
      height > 0
    ) {
      const textHeight =
        node.type === 'text'
          ? estimateTextNodeHeight(text, width)
          : node.type === 'panel'
            ? estimatePanelTextBottom(text, width)
            : 0;

      if (textHeight > height * OVERFLOW_RATIO) {
        issues.push({
          level: 'warning',
          code: 'text_overflow',
          nodeIds: [node.id],
          message: `Text needs about ${Math.round(textHeight)}px but the node is ${height}px tall`,
          hint: 'Make the node taller or wider, or shorten the text',
        });
      }

      if (
        node.type === 'note' &&
        estimateNoteFontPx(text, width, height) < MIN_NOTE_FONT
      ) {
        issues.push({
          level: 'warning',
          code: 'note_text_too_long',
          nodeIds: [node.id],
          message: 'The note shrinks its text below 18px to fit',
          hint: 'Shorten the text or split it into several notes',
        });
      }
    }

    if (node.type === 'arrow') {
      const missing = [content.startAttachment, content.endAttachment]
        .map((attachment) => attachment?.nodeId)
        .filter((id): id is string => !!id && !ids.has(id));

      if (missing.length) {
        issues.push({
          level: 'warning',
          code: 'dangling_attachment',
          nodeIds: [node.id],
          message: `Attached to missing node ${missing.join(', ')}`,
          hint: 'Remove the attachment or attach it to an existing node',
        });
      }
    }
  });

  notes.forEach((a, index) => {
    notes.slice(index + 1).forEach((b) => {
      if (!inScope(a.node) && !inScope(b.node)) {
        return;
      }

      const smaller = Math.min(
        a.bounds.width * a.bounds.height,
        b.bounds.width * b.bounds.height,
      );

      if (intersectionArea(a.bounds, b.bounds) > smaller * NOTE_OVERLAP_RATIO) {
        issues.push({
          level: 'warning',
          code: 'note_overlap',
          nodeIds: [a.node.id, b.node.id],
          message: 'Notes overlap',
          hint: 'Leave at least 40px between notes',
        });
      }
    });
  });

  panels.forEach((panel) => {
    const text = textOf(panel.node);
    const contained = notes.filter((note) =>
      rectContains(panel.bounds, note.bounds),
    );

    if (text) {
      const header: Rect = {
        ...panel.bounds,
        height: estimatePanelTextBottom(text, panel.bounds.width),
      };

      notes
        .filter(
          (note) =>
            (inScope(panel.node) || inScope(note.node)) &&
            rectsIntersect(header, note.bounds),
        )
        .forEach((note) => {
          issues.push({
            level: 'warning',
            code: 'note_in_header',
            nodeIds: [note.node.id, panel.node.id],
            message: "The note covers the panel's title",
            hint: `Move the note below y=${Math.ceil(header.y + header.height)}`,
          });
        });
    }

    if (
      contentOf(panel.node).color &&
      contained.length &&
      (inScope(panel.node) || contained.some((note) => inScope(note.node)))
    ) {
      issues.push({
        level: 'warning',
        code: 'panel_color_recolors_notes',
        nodeIds: [panel.node.id, ...contained.map((note) => note.node.id)],
        message: "The panel's color overrides the color of every note in it",
        hint: 'Set backgroundColor on the panel instead of color',
      });
    }
  });

  if (existing.size) {
    const before = placed.filter((it) => existing.has(it.node.id));
    // a panel or group the node sits inside is a frame, not an obstacle
    const blocks = (it: Placed, other: Placed) =>
      rectsIntersect(it.bounds, other.bounds) &&
      !(
        FRAME_TYPES.has(other.node.type) &&
        rectContains(other.bounds, it.bounds)
      );
    const overlapping = placed.filter(
      (it) =>
        !existing.has(it.node.id) &&
        inScope(it.node) &&
        before.some((other) => blocks(it, other)),
    );

    if (overlapping.length) {
      issues.push({
        level: 'warning',
        code: 'overlaps_existing',
        nodeIds: overlapping.map((it) => it.node.id),
        message: `${overlapping.length} node(s) overlap content that was already on the board`,
        hint: 'Place them elsewhere, e.g. right of or below the existing content',
      });
    }
  }

  return issues;
}
