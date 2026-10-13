import type { Point } from '../models/point.model.js';
import {
  boundsOfNodes,
  rotatePoint,
  unionRects,
  type Rect,
} from './geometry.js';
import {
  isSvgUrl,
  layoutSpecSchema,
  type LayoutCell,
  type LayoutDecoration,
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

// panel borderRadius for each cell style shape; pill is capped
export const CELL_RADIUS = {
  default: 12,
  rect: 0,
  rounded: 24,
  pillMax: 150,
} as const;

const { NOTE, SLOT_GAP, PAD, CELL_GAP, TITLE_GAP } = LAYOUT_SIZES;
const MIN_HEADER = 120;
const HEADER_GAP = 28;
const TEXT_EXTRA = 8;
const AXIS_WIDTH = 300;
const AXIS_GAP = 20;
const DEFAULT_CAPACITY = 6;
// radial cells sit around a centre, so they default to two rows of notes
const RADIAL_CAPACITY = 4;
const EPSILON = 1e-9;

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

interface Size {
  width: number;
  height: number;
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

const centerOf = (rect: Rect): Point => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

// the axis-aligned box a rotated decoration covers, offset included
function decorationFootprint(decoration: LayoutDecoration): Size {
  const rad = ((decoration.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const { width, height } = decoration;

  return {
    width: width * cos + height * sin + 2 * Math.abs(decoration.offset?.x ?? 0),
    height:
      width * sin + height * cos + 2 * Math.abs(decoration.offset?.y ?? 0),
  };
}

/**
 * The smallest radius at which no two cells (and no cell and the centre
 * hole) come closer than CELL_GAP. Two axis-aligned rects are apart when
 * they are apart on either axis, so each pair needs the smaller of its two
 * per-axis radii. One extra pixel absorbs rounding the positions.
 */
function ringRadius(angles: number[], cell: Size, hole: Size | null) {
  const gap = CELL_GAP + 1;
  const need = (dx: number, dy: number, spanX: number, spanY: number) =>
    Math.min(
      Math.abs(dx) > EPSILON ? spanX / Math.abs(dx) : Infinity,
      Math.abs(dy) > EPSILON ? spanY / Math.abs(dy) : Infinity,
    );
  let radius = 0;

  angles.forEach((a, index) => {
    if (hole) {
      radius = Math.max(
        radius,
        need(
          Math.cos(a),
          Math.sin(a),
          (cell.width + hole.width) / 2 + gap,
          (cell.height + hole.height) / 2 + gap,
        ),
      );
    }

    angles.slice(index + 1).forEach((b) => {
      radius = Math.max(
        radius,
        need(
          Math.cos(a) - Math.cos(b),
          Math.sin(a) - Math.sin(b),
          cell.width + gap,
          cell.height + gap,
        ),
      );
    });
  });

  return Math.ceil(radius);
}

/**
 * Cells evenly on a circle around (0, 0), the first at the top and the rest
 * clockwise.
 */
function radialCellRects(count: number, cell: Size, hole: Size | null) {
  const angles = Array.from(
    { length: count },
    (_, index) => -Math.PI / 2 + (2 * Math.PI * index) / count,
  );
  const radius = ringRadius(angles, cell, hole);

  return angles.map((angle): Rect => ({
    x: Math.round(radius * Math.cos(angle) - cell.width / 2),
    y: Math.round(radius * Math.sin(angle) - cell.height / 2),
    ...cell,
  }));
}

function gridCellRects(count: number, columns: number, cell: Size) {
  return Array.from({ length: count }, (_, index): Rect => ({
    x: (index % columns) * (cell.width + CELL_GAP),
    y: Math.floor(index / columns) * (cell.height + CELL_GAP),
    ...cell,
  }));
}

function panelStyle(cell: LayoutCell, size: Size) {
  const style = cell.style ?? {};
  const shape = style.shape;
  const borderRadius =
    shape === 'pill'
      ? Math.min(
          CELL_RADIUS.pillMax,
          Math.floor(Math.min(size.width, size.height) / 2),
        )
      : shape
        ? CELL_RADIUS[shape]
        : CELL_RADIUS.default;

  // a null backgroundColor falls back to white in the web app
  if (style.frameless) {
    return { backgroundColor: 'transparent', borderWidth: 0, borderRadius };
  }

  const backgroundColor = style.backgroundColor ?? cell.backgroundColor;

  return {
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(style.borderColor ? { borderColor: style.borderColor } : {}),
    borderWidth: style.borderWidth ?? 1,
    borderRadius,
  };
}

// where a corner anchor sits on a rect
function cornerOf(rect: Rect, corner: string): Point {
  if (corner === 'center') {
    return centerOf(rect);
  }

  return {
    x: corner.endsWith('left') ? rect.x : rect.x + rect.width,
    y: corner.startsWith('top') ? rect.y : rect.y + rect.height,
  };
}

/**
 * A decoration node whose visual centre lands on `target` (plus its offset).
 * Nodes rotate around their top-left corner.
 */
function decorationNode(
  ref: string,
  decoration: LayoutDecoration,
  target: Point,
): BoardTemplateNode {
  const rotation = decoration.rotation ?? 0;
  const half = rotatePoint(
    { x: decoration.width / 2, y: decoration.height / 2 },
    rotation,
  );

  return {
    ref,
    type: isSvgUrl(decoration.url) ? 'vector' : 'image',
    content: {
      position: {
        x: Math.round(target.x + (decoration.offset?.x ?? 0) - half.x),
        y: Math.round(target.y + (decoration.offset?.y ?? 0) - half.y),
      },
      width: decoration.width,
      height: decoration.height,
      layer: 1,
      rotation,
      url: decoration.url,
    },
  };
}

const rectOf = (node: BoardTemplateNode): Rect => ({
  ...node.content.position,
  width: node.content['width'] as number,
  height: node.content['height'] as number,
});

/**
 * Expands a columns/grid/quadrants/radial spec into template data. The
 * geometry is deterministic: every cell has the same size and 300x300 note
 * slots, with at least one empty row. Radial cells sit on a circle around
 * the centre decorations. Throws on an invalid spec.
 *
 * z-order: 'behind' decorations, panels, other decorations, texts, notes.
 */
export function expandLayout(
  input: LayoutSpecInput,
  options: { noteColor: string },
): ExpandedLayout {
  const spec = layoutSpecSchema.parse(input);
  const radial = spec.kind === 'radial';
  const decorations = spec.decorations ?? [];
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
  const defaultCapacity = radial ? RADIAL_CAPACITY : DEFAULT_CAPACITY;
  const rows = Math.max(
    ...spec.cells.map((cell) =>
      Math.max(
        Math.ceil((cell.capacity ?? defaultCapacity) / noteColumns),
        Math.ceil(cell.notes.length / noteColumns) + 1,
      ),
    ),
  );
  const cellHeight = headerHeight + rows * NOTE + (rows - 1) * SLOT_GAP + PAD;
  const cellSize = { width: cellWidth, height: cellHeight };

  // the cells relative to their own origin; radial rings are centred on 0,0
  const centerDecorations = decorations.filter((it) => it.anchor === 'center');
  // even whole pixels, so the hole's edges (which can set the layout's left
  // or top) are whole and every cell keeps a whole-pixel position
  const evenCeil = (value: number) => 2 * Math.ceil(value / 2 - EPSILON);
  const hole: Size | null =
    radial && centerDecorations.length
      ? {
          width: evenCeil(
            Math.max(
              ...centerDecorations.map((it) => decorationFootprint(it).width),
            ),
          ),
          height: evenCeil(
            Math.max(
              ...centerDecorations.map((it) => decorationFootprint(it).height),
            ),
          ),
        }
      : null;
  const columns = gridColumns(spec);
  const localRects = radial
    ? radialCellRects(spec.cells.length, cellSize, hole)
    : gridCellRects(spec.cells.length, columns, cellSize);
  const localGrid = unionRects([
    ...localRects,
    ...(hole ? [{ x: -hole.width / 2, y: -hole.height / 2, ...hole }] : []),
  ]) as Rect;

  const left = spec.axes?.y ? AXIS_WIDTH + AXIS_GAP : 0;
  const texts: BoardTemplateNode[] = [];
  let top = 0;

  if (spec.title) {
    texts.push(
      textNode('title', { x: left, y: top }, localGrid.width, [
        { preset: 'display', text: spec.title },
      ]),
    );
    top += heightOf(texts[texts.length - 1]);
  }

  if (spec.description) {
    texts.push(
      textNode('description', { x: left, y: top }, localGrid.width, [
        { preset: 'caption', text: spec.description },
      ]),
    );
    top += heightOf(texts[texts.length - 1]);
  }

  if (top > 0) {
    top += TITLE_GAP;
  }

  const toLayout = (point: Point) => ({
    x: left + point.x - localGrid.x,
    y: top + point.y - localGrid.y,
  });
  const gridRect: Rect = { ...localGrid, ...toLayout(localGrid) };
  // centre and behind decorations: the ring centre or the middle of the grid
  const middle = radial ? toLayout({ x: 0, y: 0 }) : centerOf(gridRect);

  const panels: BoardTemplateNode[] = [];
  const notes: BoardTemplateNode[] = [];

  const cells: ExpandedCell[] = spec.cells.map((cell, index) => {
    const ref = `cell-${index}`;
    const { x, y } = toLayout(localRects[index]);
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
        ...panelStyle(cell, cellSize),
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
  const axisY = top + gridRect.height + AXIS_GAP;

  const axisTexts = [
    { ref: 'axis-y-0', text: yTop, x: 0, y: rowCenter(0), align: 'right' },
    { ref: 'axis-y-1', text: yBottom, x: 0, y: rowCenter(1), align: 'right' },
    { ref: 'axis-x-0', text: xLeft, x: left, y: axisY, align: 'left' },
    {
      ref: 'axis-x-1',
      text: xRight,
      x: left + gridRect.width - AXIS_WIDTH,
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

  // layout corners: the cells, the title and the axis captions
  const layoutRect = unionRects([
    gridRect,
    ...[...panels, ...texts].map(rectOf),
  ]) as Rect;
  const behind: BoardTemplateNode[] = [];
  const stickers: BoardTemplateNode[] = [];

  decorations.forEach((decoration, index) => {
    const { anchor } = decoration;
    const target =
      anchor === 'center' || anchor === 'behind'
        ? middle
        : typeof anchor === 'object'
          ? cornerOf(cells[anchor.cell].bounds, anchor.corner)
          : cornerOf(layoutRect, anchor);
    const node = decorationNode(`decoration-${index}`, decoration, target);

    (anchor === 'behind' ? behind : stickers).push(node);
  });

  const nodes = [...behind, ...panels, ...stickers, ...texts, ...notes];

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
  // whole-pixel shift: rotated art has fractional bounds
  const origin = { x: Math.floor(bounds.x), y: Math.floor(bounds.y) };
  const size = {
    width: Math.ceil(bounds.x + bounds.width - origin.x),
    height: Math.ceil(bounds.y + bounds.height - origin.y),
  };
  const shift = (point: Point) => ({
    x: point.x - origin.x,
    y: point.y - origin.y,
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
    size,
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

/**
 * Worked examples for docs and tests: a starfish retro (radial around the
 * starfish) and a movie-themed retro grid with sticker art.
 */
export const LAYOUT_EXAMPLES = {
  starfish: {
    kind: 'radial',
    title: 'Starfish retro',
    description: 'Five arms, one sprint: what should we change?',
    cells: [
      {
        title: 'Keep doing',
        notes: ['Pairing on reviews'],
        style: { shape: 'rounded', backgroundColor: '#e6f4ea' },
      },
      {
        title: 'More of',
        style: { shape: 'rounded', backgroundColor: '#e8f0fe' },
      },
      {
        title: 'Start doing',
        style: { shape: 'rounded', backgroundColor: '#fef7e0' },
      },
      {
        title: 'Stop doing',
        style: { shape: 'rounded', backgroundColor: '#fce8e6' },
      },
      {
        title: 'Less of',
        style: { shape: 'rounded', backgroundColor: '#f3e8fd' },
      },
    ],
    decorations: [
      {
        url: 'https://cocomaterial.com/media/sea_starfish_1.svg',
        anchor: 'center',
        width: 600,
        height: 616,
      },
    ],
  },
  movieRetro: {
    kind: 'grid',
    title: 'Sprint at the movies',
    description: 'Review the sprint like a film festival',
    gridColumns: 2,
    cells: [
      { title: 'Blockbusters', subtitle: 'What was a hit' },
      { title: 'Flops', subtitle: 'What bombed' },
      { title: 'Plot twists', subtitle: 'What surprised us' },
      { title: 'Sequels', subtitle: 'What we do next' },
    ],
    decorations: [
      {
        url: 'https://cocomaterial.com/media/culture_cinema_clapperboard.svg',
        anchor: 'top-right',
        width: 320,
        height: 320,
        rotation: 12,
      },
      {
        url: 'https://cocomaterial.com/media/food_popcorn.svg',
        anchor: 'bottom-left',
        width: 300,
        height: 300,
        rotation: -8,
      },
    ],
  },
} satisfies Record<string, LayoutSpecInput>;
