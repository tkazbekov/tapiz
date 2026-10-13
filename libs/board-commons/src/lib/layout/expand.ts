import type { Point } from '../models/point.model.js';
import { boundsOfNodes, type Rect } from './geometry.js';
import {
  layoutSpecSchema,
  type LayoutSpec,
  type LayoutSpecInput,
} from './layout-spec.js';
import {
  parseBoardTemplate,
  type BoardTemplateData,
  type BoardTemplateNode,
} from './template-format.js';
import {
  estimatePanelTextBottom,
  estimateTextNodeHeight,
} from './text-estimate.js';
import { plainHtml, presetHtml, type TextBlock } from './text-presets.js';

export const LAYOUT_SIZES = {
  NOTE: 300,
  SLOT_GAP: 40,
  PAD: 40,
  CELL_GAP: 60,
  TITLE_GAP: 60,
} as const;

export const MAX_LAYOUT_NODES = 300;

const { NOTE, SLOT_GAP, PAD, CELL_GAP, TITLE_GAP } = LAYOUT_SIZES;
const MIN_HEADER = 120;
const HEADER_GAP = 28;
const TEXT_EXTRA = 8;
const AXIS_WIDTH = 300;
const AXIS_GAP = 20;
const DEFAULT_CAPACITY = 6;

export interface ExpandedCell {
  ref: string;
  title: string;
  bounds: Rect;
  noteRefs: string[];
  // 300x300 note positions left empty in the cell, in reading order
  freeSlots: Point[];
}

export interface ExpandedLayout {
  template: BoardTemplateData;
  cells: ExpandedCell[];
}

function gridColumns(spec: LayoutSpec) {
  if (spec.kind === 'quadrants') {
    return 2;
  }

  if (spec.kind === 'grid') {
    return Math.min(
      spec.gridColumns ?? Math.ceil(Math.sqrt(spec.cells.length)),
      spec.cells.length,
    );
  }

  return spec.cells.length;
}

function textNode(
  ref: string,
  position: Point,
  width: number,
  blocks: TextBlock[],
): BoardTemplateNode {
  const text = presetHtml(blocks);

  return {
    ref,
    type: 'text',
    content: {
      position,
      width,
      height: estimateTextNodeHeight(text, width) + TEXT_EXTRA,
      layer: 1,
      rotation: 0,
      text,
    },
  };
}

const heightOf = (node: BoardTemplateNode) => node.content['height'] as number;

/**
 * Expands a columns/grid/quadrants spec into template data. The geometry is
 * deterministic: every cell has the same size and 300x300 note slots, with
 * at least one empty row. Throws on an invalid spec.
 */
export function expandLayout(
  input: LayoutSpecInput,
  options: { noteColor: string },
): ExpandedLayout {
  const spec = layoutSpecSchema.parse(input);
  const noteColumns = spec.noteColumns ?? 2;
  const noteColor = spec.noteColor ?? options.noteColor;
  const cellWidth = 2 * PAD + noteColumns * NOTE + (noteColumns - 1) * SLOT_GAP;

  const headers = spec.cells.map((cell) =>
    presetHtml([
      { preset: 'title', text: cell.title },
      ...(cell.subtitle
        ? [{ preset: 'caption' as const, text: cell.subtitle }]
        : []),
    ]),
  );
  const headerHeight = Math.max(
    MIN_HEADER,
    ...headers.map(
      (html) => estimatePanelTextBottom(html, cellWidth) + HEADER_GAP,
    ),
  );
  const rows = Math.max(
    ...spec.cells.map((cell) =>
      Math.max(
        Math.ceil((cell.capacity ?? DEFAULT_CAPACITY) / noteColumns),
        Math.ceil(cell.notes.length / noteColumns) + 1,
      ),
    ),
  );
  const cellHeight = headerHeight + rows * NOTE + (rows - 1) * SLOT_GAP + PAD;

  const columns = gridColumns(spec);
  const gridRows = Math.ceil(spec.cells.length / columns);
  const gridWidth = columns * cellWidth + (columns - 1) * CELL_GAP;
  const gridHeight = gridRows * cellHeight + (gridRows - 1) * CELL_GAP;
  const left = spec.axes?.y ? AXIS_WIDTH + AXIS_GAP : 0;

  const panels: BoardTemplateNode[] = [];
  const texts: BoardTemplateNode[] = [];
  const notes: BoardTemplateNode[] = [];
  let top = 0;

  if (spec.title) {
    texts.push(
      textNode('title', { x: left, y: top }, gridWidth, [
        { preset: 'display', text: spec.title },
      ]),
    );
    top += heightOf(texts[texts.length - 1]);
  }

  if (spec.description) {
    texts.push(
      textNode('description', { x: left, y: top }, gridWidth, [
        { preset: 'caption', text: spec.description },
      ]),
    );
    top += heightOf(texts[texts.length - 1]);
  }

  if (top > 0) {
    top += TITLE_GAP;
  }

  const cells: ExpandedCell[] = spec.cells.map((cell, index) => {
    const ref = `cell-${index}`;
    const x = left + (index % columns) * (cellWidth + CELL_GAP);
    const y = top + Math.floor(index / columns) * (cellHeight + CELL_GAP);
    const slots = Array.from({ length: rows * noteColumns }, (_, slot) => ({
      x: x + PAD + (slot % noteColumns) * (NOTE + SLOT_GAP),
      y: y + headerHeight + Math.floor(slot / noteColumns) * (NOTE + SLOT_GAP),
    }));

    panels.push({
      ref,
      type: 'panel',
      content: {
        position: { x, y },
        width: cellWidth,
        height: cellHeight,
        layer: 1,
        text: headers[index],
        ...(cell.backgroundColor
          ? { backgroundColor: cell.backgroundColor }
          : {}),
        borderWidth: 1,
        borderRadius: 12,
        rotation: 0,
        drawing: [],
      },
    });

    const noteRefs = cell.notes.map((text, slot) => {
      const noteRef = `${ref}-note-${slot}`;

      notes.push({
        ref: noteRef,
        type: 'note',
        content: {
          position: slots[slot],
          width: NOTE,
          height: NOTE,
          layer: 0,
          text: plainHtml(text),
          votes: [],
          emojis: [],
          drawing: [],
          ownerId: '',
          color: noteColor,
        },
      });

      return noteRef;
    });

    return {
      ref,
      title: cell.title,
      bounds: { x, y, width: cellWidth, height: cellHeight },
      noteRefs,
      freeSlots: slots.slice(cell.notes.length),
    };
  });

  const [yTop, yBottom] = spec.axes?.y ?? [];
  const [xLeft, xRight] = spec.axes?.x ?? [];
  const rowCenter = (row: number) =>
    top + row * (cellHeight + CELL_GAP) + cellHeight / 2;
  const axisY = top + gridHeight + AXIS_GAP;

  const axisTexts = [
    { ref: 'axis-y-0', text: yTop, x: 0, y: rowCenter(0), align: 'right' },
    { ref: 'axis-y-1', text: yBottom, x: 0, y: rowCenter(1), align: 'right' },
    { ref: 'axis-x-0', text: xLeft, x: left, y: axisY, align: 'left' },
    {
      ref: 'axis-x-1',
      text: xRight,
      x: left + gridWidth - AXIS_WIDTH,
      y: axisY,
      align: 'right',
    },
  ] as const;

  axisTexts.forEach((axis) => {
    if (!axis.text) {
      return;
    }

    const node = textNode(axis.ref, { x: axis.x, y: axis.y }, AXIS_WIDTH, [
      { preset: 'caption', text: axis.text, align: axis.align },
    ]);

    // y captions are centred on their row
    if (axis.ref.startsWith('axis-y')) {
      node.content.position = {
        x: axis.x,
        y: Math.round(axis.y - heightOf(node) / 2),
      };
    }

    texts.push(node);
  });

  const nodes = [...panels, ...texts, ...notes];

  if (nodes.length > MAX_LAYOUT_NODES) {
    throw new Error(
      `layout_too_large: ${nodes.length} nodes (max ${MAX_LAYOUT_NODES}); split the layout into several calls`,
    );
  }

  const bounds = boundsOfNodes(
    nodes.map((node) => ({
      id: node.ref,
      type: node.type,
      content: node.content,
    })),
  ) ?? { x: 0, y: 0, width: 0, height: 0 };
  const shift = (point: Point) => ({
    x: point.x - bounds.x,
    y: point.y - bounds.y,
  });

  nodes.forEach((node) => {
    node.content.position = shift(node.content.position);
  });
  cells.forEach((cell) => {
    cell.bounds = { ...cell.bounds, ...shift(cell.bounds) };
    cell.freeSlots = cell.freeSlots.map(shift);
  });

  const parsed = parseBoardTemplate({
    version: 1,
    size: { width: bounds.width, height: bounds.height },
    nodes,
  });

  if (!parsed.ok) {
    throw new Error(
      `invalid layout: ${parsed.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  return { template: parsed.data, cells };
}
