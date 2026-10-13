import {
  estimateNoteFontPx,
  isAppTemplateAssetUrl,
  isCocomaterialUrl,
  nodeBounds,
  nodeSize,
  nodesById,
  type NodesById,
  type Point,
  rectsIntersect,
  type Rect,
  resolveArrowGeometry,
  type TuNode,
} from '@tapiz/board-commons';
import { PreviewRenderError, renderSvgToPng } from './preview-renderer.js';

/*
 * A server-side PNG of part of a board, for agents that can't open a browser.
 * The caller masks the board for the viewer first. Only Cocomaterial art and
 * the web app's own template art (from FRONTEND_URL) are fetched; every other
 * image is a labelled placeholder (no SSRF).
 */

// runtime nodes that are not drawn on the board
const SKIPPED_TYPES = new Set(['user', 'settings', 'timer']);

const BOARD_BACKGROUND = '#f8f9fa';
const TEXT_COLOR = '#212529';
const FONT_FAMILY = 'Inter, Lato, DejaVu Sans, sans-serif';

// text-estimate.ts and the web components
const CHAR_WIDTH_EM = 0.55;
const DEFAULT_FONT_SIZE = 24;
const DEFAULT_LINE_HEIGHT = 1.2;
const BLOCK_MARGIN = 4;
const TAG_FONT_SIZES: Record<string, number> = { h1: 320, h2: 160, h3: 80 };
const NOTE_PADDING = 18;
const NOTE_LINE_HEIGHT = 1.1;
const NOTE_RADIUS = 20;
const DEFAULT_NOTE_COLOR = '#fbb980';
const PANEL_INSET = 13;
const PANEL_BORDER_COLOR = '#e8e9ea';
const GROUP_PADDING = 24;
const ARROW_COLOR = '#343a40';
const ARROW_HEAD = 4;
const MAX_TEXT_LINES = 400;
// rendering cost is mostly text shaping; cap it per node and per preview
const MAX_NODE_HTML = 5000;
const MAX_PREVIEW_TEXT_LINES = 6000;

// keeps a tall region from allocating a huge raster
export const MAX_PREVIEW_HEIGHT = 4800;
export const MAX_PREVIEW_WIDTH = 1600;
// in board units; a smaller viewBox loses precision in the SVG
export const MIN_PREVIEW_REGION = 1;

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const ASSET_TIMEOUT_MS = 5000;
const MAX_ASSETS_PER_RENDER = 60;
const ASSET_CACHE_ENTRIES = 200;
const ASSET_CACHE_BYTES = 48 * 1024 * 1024;
const ASSET_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface PreviewSkippedAsset {
  url: string;
  reason: string;
}

export interface BoardPreviewOptions {
  width: number;
  // pixels; by default from the region's aspect ratio
  height?: number;
  // asset url -> data uri, from loadPreviewAssets
  assets: Map<string, string>;
  // a note hidden with textHidden still shows to its owner
  viewerId?: string;
}

type Content = Record<string, unknown>;

const contentOf = (node: TuNode) => (node.content ?? {}) as Content;

// a finite number, or the fallback; nothing else reaches an attribute
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const fmt = (value: number) =>
  String(Math.round((Number.isFinite(value) ? value : 0) * 100) / 100);

const str = (value: unknown) => (typeof value === 'string' ? value : '');

// characters XML 1.0 does not allow, even escaped
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const COLOR_PATTERNS = [
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*\d{1,3}%?(?:\s*,\s*\d{1,3}%?){2}(?:\s*,\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)$/i,
  /^hsla?\(\s*\d{1,3}(?:deg)?(?:\s*,\s*\d{1,3}%){2}(?:\s*,\s*(?:0|1|0?\.\d+|\d{1,3}%))?\s*\)$/i,
];

// a color safe to put in an attribute, else the fallback
export function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const color = value.trim();

  if (color.toLowerCase() === 'transparent') {
    return 'none';
  }

  return COLOR_PATTERNS.some((pattern) => pattern.test(color))
    ? color
    : fallback;
}

/* ---------- rich text ---------- */

interface RunStyle {
  bold: boolean;
  color: string | null;
}

interface Run extends RunStyle {
  text: string;
  // one emoji cluster, drawn as a placeholder shape
  emoji?: boolean;
}

/*
 * The server has no emoji font, so emoji would render as empty boxes. Each
 * cluster (emoji-presentation or U+FE0F-qualified pictographs, astral
 * pictographs, flags, keycaps, with skin tones, tags and ZWJ sequences) is
 * drawn as a neutral shape instead. A text-default pictograph followed by a
 * skin tone or a ZWJ starts a cluster too, as in ☝🏽 or the unqualified ❤‍🔥.
 * Text-presentation symbols such as © ™ ★ ✓ stay text: the preview font has
 * them.
 */
const EMOJI_CLUSTER_RE =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}(?:\uFE0F|(?=\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}))|[\u{1F000}-\u{1FAFF}])\p{Emoji_Modifier}?[\uFE0E\uFE0F]?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)/gu;
// variation selectors left outside a cluster are invisible in a browser, as is
// a stray ZWJ; one between letters or marks shapes scripts such as Devanagari
// and Arabic, so it stays
const STRAY_SELECTORS_RE =
  /[\uFE0E\uFE0F]|\u200D(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])\u200D/gu;
// an emoji counts as this many characters when wrapping
const EMOJI_CHARS = 2;
// the slot of an emoji placeholder on its line, in em
const EMOJI_SLOT_EM = 1.2;
const EMOJI_FILL = '#e9ecef';
const EMOJI_STROKE = '#868e96';

/** Text split into plain parts and single emoji clusters, in order. */
export function splitEmoji(text: string): { text: string; emoji: boolean }[] {
  const parts: { text: string; emoji: boolean }[] = [];
  let last = 0;

  const plain = (part: string) => {
    const cleaned = part.replace(STRAY_SELECTORS_RE, '');

    if (cleaned) {
      parts.push({ text: cleaned, emoji: false });
    }
  };

  for (const match of text.matchAll(EMOJI_CLUSTER_RE)) {
    plain(text.slice(last, match.index));
    parts.push({ text: match[0], emoji: true });
    last = match.index + match[0].length;
  }

  plain(text.slice(last));

  return parts;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The first max user-perceived characters of text. Cuts between grapheme
 * clusters, so an emoji (keycap, flag, ZWJ sequence) is kept whole or dropped.
 */
export function truncateGraphemes(text: string, max: number): string {
  let out = '';
  let count = 0;

  for (const { segment } of graphemes.segment(text)) {
    if (count++ >= max) {
      break;
    }

    out += segment;
  }

  return out;
}

const plainRuns = (text: string, style: RunStyle): Run[] =>
  splitEmoji(text).map((part) => ({ ...style, ...part }));

interface TextBlock {
  tag: string;
  align: 'start' | 'middle' | 'end';
  fontPx: number;
  lineHeight: number;
  // one entry per <br>-separated line
  lines: Run[][];
}

interface ParsedBlock extends Omit<TextBlock, 'fontPx' | 'lineHeight'> {
  sizes: number[];
  heights: number[];
}

interface StyleFrame {
  tag: string;
  bold?: boolean;
  color?: string;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'li']);
const HTML_TAG_RE = /<(\/?)([a-z][a-z0-9]*)\b([^<>]*)>/gi;
const FONT_SIZE_RE = /font-size:\s*(\d+(?:\.\d+)?)px/i;
const LINE_HEIGHT_RE = /line-height:\s*(\d+(?:\.\d+)?)\s*(?:[;"']|$)/i;
const COLOR_RE = /(?:^|[;"'\s])color:\s*([^;"']+)/i;
const ALIGN_RE = /text-align:\s*(left|center|right|justify)/i;

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi,
    (entity, name: string) => {
      if (name.startsWith('#')) {
        const code =
          name[1].toLowerCase() === 'x'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);

        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }

      return ENTITIES.get(name.toLowerCase()) ?? entity;
    },
  );
}

/**
 * One block per p/h1/h2/h3/li, like text-estimate: font size from the largest
 * inline font-size, else the tag default; bold from strong/b (and headings);
 * color from the nearest span color. Text outside any block is a paragraph.
 */
export function parseRichText(html: string, baseFontPx: number): TextBlock[] {
  const blocks: ParsedBlock[] = [];
  const stack: StyleFrame[] = [];
  let block: ParsedBlock | null = null;

  const open = (tag: string, attrs: string): ParsedBlock => {
    const align = ALIGN_RE.exec(attrs)?.[1].toLowerCase();
    const opened: ParsedBlock = {
      tag,
      align:
        align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start',
      lines: [[]],
      sizes: [],
      heights: [],
    };

    blocks.push(opened);
    block = opened;

    return opened;
  };

  const close = () => {
    block = null;
  };

  const current = (): ParsedBlock => block ?? open('p', '');

  const addText = (raw: string) => {
    const text = decodeEntities(raw);

    if (!text) {
      return;
    }

    if (!block && !text.trim()) {
      return;
    }

    const target = current();
    const color = [...stack].reverse().find((frame) => frame.color)?.color;

    target.lines[target.lines.length - 1].push(
      ...plainRuns(text, {
        bold:
          stack.some((frame) => frame.bold) || TAG_FONT_SIZES[target.tag] > 0,
        color: color ?? null,
      }),
    );
  };

  let last = 0;

  for (const match of html.matchAll(HTML_TAG_RE)) {
    addText(html.slice(last, match.index));
    last = match.index + match[0].length;

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3];

    if (BLOCK_TAGS.has(tag)) {
      if (closing) {
        close();
      } else {
        close();
        open(tag, attrs);
      }

      continue;
    }

    if (tag === 'br') {
      current().lines.push([]);
      continue;
    }

    if (closing) {
      const index = stack.map((frame) => frame.tag).lastIndexOf(tag);

      if (index >= 0) {
        stack.splice(index, 1);
      }

      continue;
    }

    if (attrs.trimEnd().endsWith('/')) {
      continue;
    }

    const frame: StyleFrame = { tag };

    if (tag === 'strong' || tag === 'b') {
      frame.bold = true;
    }

    const fontPx = Number(FONT_SIZE_RE.exec(attrs)?.[1] ?? 0);
    const lineHeight = Number(LINE_HEIGHT_RE.exec(attrs)?.[1] ?? 0);
    const color = COLOR_RE.exec(attrs)?.[1];

    if (color) {
      frame.color = safeColor(color, TEXT_COLOR);
    }

    if (fontPx > 0 || lineHeight > 0) {
      const target = current();

      if (fontPx > 0) {
        target.sizes.push(fontPx);
      }

      if (lineHeight > 0) {
        target.heights.push(lineHeight);
      }
    }

    stack.push(frame);
  }

  addText(html.slice(last));

  return blocks.map(({ sizes, heights, ...rest }): TextBlock => ({
    ...rest,
    fontPx: Math.max(0, ...sizes) || TAG_FONT_SIZES[rest.tag] || baseFontPx,
    lineHeight: Math.max(0, ...heights),
  }));
}

type Piece = Run;

// emoji pieces never merge: each is one placeholder
const mergeable = (a: Run, b: Run) =>
  !a.emoji && !b.emoji && a.bold === b.bold && a.color === b.color;

const pieceLength = (piece: Piece) =>
  piece.emoji ? EMOJI_CHARS : [...piece.text].length;

// words of styled pieces; a word can change style midway
function toWords(runs: Run[]): Piece[][] {
  const words: Piece[][] = [];
  let word: Piece[] = [];

  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) {
        continue;
      }

      if (/^\s+$/.test(part)) {
        if (word.length) {
          words.push(word);
        }

        word = [];
      } else {
        word.push({ ...run, text: part });
      }
    }
  }

  if (word.length) {
    words.push(word);
  }

  return words;
}

const wordLength = (word: Piece[]) =>
  word.reduce((sum, piece) => sum + pieceLength(piece), 0);

// a word longer than the line breaks anywhere but inside an emoji
function splitWord(word: Piece[], maxChars: number): Piece[][] {
  const chars = word.flatMap((piece) =>
    piece.emoji
      ? [piece]
      : [...piece.text].map((char) => ({ ...piece, text: char })),
  );
  const parts: Piece[][] = [];
  let part: Piece[] = [];
  let length = 0;

  for (const char of chars) {
    const charLength = pieceLength(char);

    if (part.length && length + charLength > maxChars) {
      parts.push(part);
      part = [];
      length = 0;
    }

    part.push(char);
    length += charLength;
  }

  if (part.length) {
    parts.push(part);
  }

  return parts;
}

// greedy, like text-estimate's wrappedLines; at least one (maybe empty) line
export function wrapRuns(
  runs: Run[],
  fontPx: number,
  width: number,
): Piece[][] {
  const charWidth = fontPx * CHAR_WIDTH_EM;
  const maxChars = Math.max(1, Math.floor(width / charWidth));
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let length = 0;

  const push = () => {
    lines.push(line);
    line = [];
    length = 0;
  };

  for (const word of toWords(runs)) {
    const parts =
      wordLength(word) > maxChars ? splitWord(word, maxChars) : [word];

    for (const part of parts) {
      const partLength = wordLength(part);

      if (length === 0) {
        line.push(...part);
        length = partLength;
      } else if (length + 1 + partLength <= maxChars) {
        line.push(
          { ...line[line.length - 1], text: ' ', emoji: false },
          ...part,
        );
        length += 1 + partLength;
      } else {
        push();
        line.push(...part);
        length = partLength;
      }
    }
  }

  if (line.length || !lines.length) {
    push();
  }

  return lines;
}

function mergePieces(pieces: Piece[]): Piece[] {
  return pieces.reduce<Piece[]>((merged, piece) => {
    const previous = merged[merged.length - 1];

    if (previous && mergeable(previous, piece)) {
      previous.text += piece.text;
    } else {
      merged.push({ ...piece });
    }

    return merged;
  }, []);
}

export interface PreviewStats {
  // emoji clusters drawn as placeholder shapes
  emojiPlaceholders: number;
}

interface LineStyle {
  x: number;
  baseline: number;
  fontPx: number;
  fill: string;
  // text-anchor; omitted for start when undefined
  anchor?: 'start' | 'middle' | 'end';
  // the whole line in bold
  bold?: boolean;
  stats?: PreviewStats;
}

const tspan = (piece: Piece, x?: number) => {
  const attrs = [
    x === undefined ? '' : ` x="${fmt(x)}"`,
    piece.bold ? ' font-weight="700"' : '',
    piece.color ? ` fill="${escapeXml(piece.color)}"` : '',
  ].join('');

  return `<tspan${attrs}>${escapeXml(piece.text)}</tspan>`;
};

// rough advance widths of Inter (the preview font), in em
const NARROW_CHARS = new Set("ijlI|!.,:;'`");
const SEMI_NARROW_CHARS = new Set('frt()[]{}"/-');
const WIDE_CHARS = new Set('mwMW');

function charWidthEm(char: string): number {
  if (/\s/.test(char)) {
    return 0.28;
  }

  if (NARROW_CHARS.has(char)) {
    return 0.26;
  }

  if (SEMI_NARROW_CHARS.has(char)) {
    return 0.37;
  }

  if (WIDE_CHARS.has(char)) {
    return 0.85;
  }

  if (/[A-Z]/.test(char)) {
    return 0.68;
  }

  return /\d/.test(char) ? 0.58 : 0.54;
}

// where a piece ends on a line with emoji; closer than the wrap estimate.
// lineBold: the whole <text> is bold, though its pieces carry no weight
const pieceWidth = (piece: Piece, fontPx: number, lineBold = false) =>
  piece.emoji
    ? EMOJI_SLOT_EM * fontPx
    : [...piece.text].reduce((sum, char) => sum + charWidthEm(char), 0) *
      fontPx *
      (piece.bold || lineBold ? 1.06 : 1);

// a rounded square in an emoji's slot, as tall as a capital letter
function emojiPlaceholderSvg(left: number, baseline: number, fontPx: number) {
  const slot = EMOJI_SLOT_EM * fontPx;
  const side = fontPx * 0.8;

  return `<rect class="emoji-placeholder" x="${fmt(left + (slot - side) / 2)}" y="${fmt(baseline - fontPx * 0.75)}" width="${fmt(side)}" height="${fmt(side)}" rx="${fmt(side * 0.22)}" fill="${EMOJI_FILL}" stroke="${EMOJI_STROKE}" stroke-width="${fmt(Math.max(1, fontPx * 0.06))}"/>`;
}

/**
 * One line of styled pieces as an SVG <text>. A line with emoji is laid out
 * with estimated character widths: each emoji becomes a placeholder shape in
 * its slot and the text after it restarts just after the slot.
 */
const textElement = (
  style: LineStyle,
  anchor: string | undefined,
  inner: string,
) =>
  `<text x="${fmt(style.x)}" y="${fmt(style.baseline)}" font-size="${fmt(style.fontPx)}"${style.bold ? ' font-weight="700"' : ''}${anchor ? ` text-anchor="${anchor}"` : ''} fill="${escapeXml(style.fill)}">${inner}</text>`;

function lineSvg(pieces: Piece[], style: LineStyle): string {
  const merged = mergePieces(pieces);

  if (!merged.some((piece) => piece.emoji)) {
    const spans = merged.map((piece) => tspan(piece)).join('');

    return spans ? textElement(style, style.anchor, spans) : '';
  }

  const total = merged.reduce(
    (sum, piece) => sum + pieceWidth(piece, style.fontPx, style.bold),
    0,
  );
  let cursor =
    style.anchor === 'middle'
      ? style.x - total / 2
      : style.anchor === 'end'
        ? style.x - total
        : style.x;
  const spans: string[] = [];
  const shapes: string[] = [];
  // the next text starts a new chunk at an explicit x
  let restart = true;

  for (const piece of merged) {
    if (piece.emoji) {
      shapes.push(emojiPlaceholderSvg(cursor, style.baseline, style.fontPx));
      restart = true;

      if (style.stats) {
        style.stats.emojiPlaceholders++;
      }
    } else if (restart) {
      // leading spaces of a chunk collapse, so they move its x instead
      const text = piece.text.trimStart();
      const lead = piece.text.slice(0, piece.text.length - text.length);

      if (text) {
        spans.push(
          tspan(
            { ...piece, text },
            cursor +
              pieceWidth({ ...piece, text: lead }, style.fontPx, style.bold),
          ),
        );
        restart = false;
      }
    } else {
      spans.push(tspan(piece));
    }

    cursor += pieceWidth(piece, style.fontPx, style.bold);
  }

  return [
    spans.length ? textElement(style, 'start', spans.join('')) : '',
    ...shapes,
  ].join('');
}

/** Plain text on one line, with emoji drawn as placeholders. */
function plainLineSvg(text: string, style: LineStyle): string {
  const runs = plainRuns(text, { bold: false, color: null });

  if (runs.some((run) => run.emoji)) {
    return lineSvg(runs, style);
  }

  const plain = runs.map((run) => run.text).join('');

  return plain ? textElement(style, style.anchor, escapeXml(plain)) : '';
}

interface TextBox {
  width: number;
  height: number;
  baseFontPx: number;
  baseLineHeight: number;
  color: string;
  // lines left for the whole preview; decremented
  budget?: { lines: number };
  stats?: PreviewStats;
}

/**
 * SVG <text> lines in a box whose top-left is 0,0. Lines whose middle falls
 * below the box are dropped instead of clipped: resvg aborts the process on
 * clip groups whose content is far outside the canvas.
 */
export function richTextSvg(html: string, box: TextBox): string {
  if (!html.trim() || box.width <= 0 || box.height <= 0) {
    return '';
  }

  const out: string[] = [];
  let top = 0;
  let count = 0;

  for (const block of parseRichText(
    html.slice(0, MAX_NODE_HTML),
    box.baseFontPx,
  )) {
    const fontPx = block.fontPx;
    const lineBox = fontPx * (block.lineHeight || box.baseLineHeight);
    const x =
      block.align === 'middle'
        ? box.width / 2
        : block.align === 'end'
          ? box.width
          : 0;

    for (const [index, runs] of block.lines.entries()) {
      const prefixed =
        block.tag === 'li' && index === 0
          ? [{ text: '• ', bold: false, color: null }, ...runs]
          : runs;

      for (const line of wrapRuns(prefixed, fontPx, box.width)) {
        if (
          top + lineBox / 2 > box.height ||
          count >= MAX_TEXT_LINES ||
          (box.budget && box.budget.lines <= 0)
        ) {
          return out.join('');
        }

        const svg = lineSvg(line, {
          x,
          baseline: top + (lineBox - fontPx) / 2 + fontPx * 0.8,
          fontPx,
          fill: box.color,
          anchor: block.align,
          stats: box.stats,
        });

        if (svg) {
          out.push(svg);
        }

        top += lineBox;
        count++;

        if (box.budget) {
          box.budget.lines--;
        }
      }
    }

    top += BLOCK_MARGIN;
  }

  return out.join('');
}

/* ---------- nodes ---------- */

interface DrawContext {
  assets: Map<string, string>;
  byId: NodesById;
  viewerId?: string;
  // every panel, topmost first, for the note colour
  panels: TuNode[];
  budget: { lines: number };
  stats: PreviewStats;
}

function drawingsSvg(drawings: unknown): string {
  if (!Array.isArray(drawings)) {
    return '';
  }

  return drawings
    .map((drawing: { points?: unknown; size?: unknown; color?: unknown }) => {
      const points = Array.isArray(drawing?.points)
        ? (drawing.points as Point[])
            .filter(
              (point) => Number.isFinite(point?.x) && Number.isFinite(point?.y),
            )
            .map((point) => `${fmt(point.x)},${fmt(point.y)}`)
        : [];

      if (!points.length) {
        return '';
      }

      return `<polyline points="${points.join(' ')}" fill="none" stroke="${escapeXml(safeColor(drawing.color, TEXT_COLOR))}" stroke-width="${fmt(num(drawing.size, 2))}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
}

function labelledRect(
  width: number,
  height: number,
  label: string,
  fill = '#e9ecef',
  stats?: PreviewStats,
) {
  const fontPx = Math.max(8, Math.min(32, width / 10, height / 3));

  return [
    `<rect width="${fmt(width)}" height="${fmt(height)}" rx="8" fill="${escapeXml(fill)}" stroke="#adb5bd" stroke-width="2" stroke-dasharray="8 6"/>`,
    plainLineSvg(label, {
      x: width / 2,
      baseline: height / 2 + fontPx * 0.35,
      fontPx,
      fill: '#495057',
      anchor: 'middle',
      stats,
    }),
  ].join('');
}

function panelSvg(
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  const borderWidth = Math.max(0, num(content['borderWidth'], 1));
  const stroke =
    borderWidth > 0
      ? ` stroke="${escapeXml(safeColor(content['borderColor'], PANEL_BORDER_COLOR))}" stroke-width="${fmt(borderWidth)}"`
      : '';
  const rx = Math.max(0, num(content['borderRadius'], 0));
  const fill = content['backgroundColor']
    ? safeColor(content['backgroundColor'], '#ffffff')
    : '#ffffff';
  const inset = PANEL_INSET + Math.max(0, borderWidth - 1);
  const text = richTextSvg(str(content['text']), {
    width: width - inset * 2,
    height: height - inset * 2,
    baseFontPx: DEFAULT_FONT_SIZE,
    baseLineHeight: DEFAULT_LINE_HEIGHT,
    color: TEXT_COLOR,
    budget: ctx.budget,
    stats: ctx.stats,
  });

  return [
    `<rect width="${fmt(width)}" height="${fmt(height)}" rx="${fmt(rx)}" fill="${escapeXml(fill)}"${stroke}/>`,
    text
      ? `<g transform="translate(${fmt(inset)} ${fmt(inset)})">${text}</g>`
      : '',
    drawingsSvg(content['drawing']),
  ].join('');
}

// the web's note findColor: the topmost panel holding the whole note
function panelColorAt(
  position: Point,
  width: number,
  height: number,
  panels: TuNode[],
): unknown {
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => ({ x: position.x + x, y: position.y + y }));

  const panel = panels.find((it) => {
    const content = contentOf(it);
    const origin = content['position'] as Point | undefined;

    if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
      return false;
    }

    const size = nodeSize(it);
    const rad = (-num(content['rotation'], 0) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    return corners.every((corner) => {
      const dx = corner.x - origin.x;
      const dy = corner.y - origin.y;
      const x = dx * cos - dy * sin;
      const y = dx * sin + dy * cos;

      return x >= 0 && x <= size.width && y >= 0 && y <= size.height;
    });
  });

  return panel && contentOf(panel)['color'];
}

function noteSvg(
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  const own = safeColor(content['color'], DEFAULT_NOTE_COLOR);
  const position = content['position'] as Point;
  const panelColor = panelColorAt(position, width, height, ctx.panels);
  const fill = panelColor ? safeColor(panelColor, own) : own;
  const hidden =
    content['textHidden'] === true && content['ownerId'] !== ctx.viewerId;
  const html = hidden ? '' : str(content['text']);
  const inner = width - NOTE_PADDING * 2;
  const text = html.trim()
    ? richTextSvg(html, {
        width: inner,
        height: height - NOTE_PADDING * 2,
        baseFontPx: estimateNoteFontPx(
          html.slice(0, MAX_NODE_HTML),
          width,
          height,
        ),
        baseLineHeight: NOTE_LINE_HEIGHT,
        color: TEXT_COLOR,
        budget: ctx.budget,
        stats: ctx.stats,
      })
    : '';

  return [
    `<rect width="${fmt(width)}" height="${fmt(height)}" rx="${NOTE_RADIUS}" fill="${escapeXml(fill)}"/>`,
    text
      ? `<g transform="translate(${NOTE_PADDING} ${NOTE_PADDING})">${text}</g>`
      : '',
    hidden ? '' : drawingsSvg(content['drawing']),
  ].join('');
}

function textNodeSvg(
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  const text = richTextSvg(str(content['text']), {
    width: width - 2,
    // text nodes grow with their text; let it overflow a little
    height: height * 1.5,
    baseFontPx: DEFAULT_FONT_SIZE,
    baseLineHeight: DEFAULT_LINE_HEIGHT,
    color: TEXT_COLOR,
    budget: ctx.budget,
    stats: ctx.stats,
  });

  return text ? `<g transform="translate(1 1)">${text}</g>` : '';
}

function groupSvg(
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  return [
    `<rect width="${fmt(width)}" height="${fmt(height)}" rx="36" fill="none" stroke="#adb5bd" stroke-width="2" stroke-dasharray="10 8"/>`,
    plainLineSvg(str(content['title']), {
      x: GROUP_PADDING,
      baseline: GROUP_PADDING + 24,
      fontPx: 28,
      fill: TEXT_COLOR,
      bold: true,
      stats: ctx.stats,
    }),
  ].join('');
}

function imageSvg(
  node: TuNode,
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  const dataUri = ctx.assets.get(str(content['url']));

  if (dataUri && dataUri.startsWith('data:image/')) {
    return `<image href="${escapeXml(dataUri)}" width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  return labelledRect(
    width,
    height,
    node.type === 'vector' ? 'vector' : 'image',
  );
}

function tokenSvg(
  content: Content,
  width: number,
  height: number,
  ctx: DrawContext,
) {
  const fontPx = Math.max(8, Math.min(width, height) / 3);

  return [
    `<ellipse cx="${fmt(width / 2)}" cy="${fmt(height / 2)}" rx="${fmt(width / 2)}" ry="${fmt(height / 2)}" fill="${escapeXml(safeColor(content['backgroundColor'], '#868e96'))}"/>`,
    plainLineSvg(truncateGraphemes(str(content['text']), 8), {
      x: width / 2,
      baseline: height / 2 + fontPx * 0.35,
      fontPx,
      fill: safeColor(content['color'], '#ffffff'),
      anchor: 'middle',
      bold: true,
      stats: ctx.stats,
    }),
  ].join('');
}

function arrowHead(tip: Point, from: Point, size: number, color: string) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const length = size * 3;
  const spread = Math.PI / 7;
  const corner = (sign: number) => ({
    x: tip.x - length * Math.cos(angle + sign * spread),
    y: tip.y - length * Math.sin(angle + sign * spread),
  });
  const a = corner(1);
  const b = corner(-1);

  return `<polygon points="${fmt(tip.x)},${fmt(tip.y)} ${fmt(a.x)},${fmt(a.y)} ${fmt(b.x)},${fmt(b.y)}" fill="${escapeXml(color)}"/>`;
}

const unit = (point: Point): Point => {
  const length = Math.hypot(point.x, point.y);

  return length ? { x: point.x / length, y: point.y / length } : { x: 0, y: 0 };
};

const rotateBy = (point: Point, rad: number): Point => ({
  x: point.x * Math.cos(rad) - point.y * Math.sin(rad),
  y: point.x * Math.sin(rad) + point.y * Math.cos(rad),
});

/**
 * The web's resolveAttachmentTangent: a curved end leaves its node along the
 * outward normal of the nearest side (ties go to the side facing the other
 * end), pointing along the curve's direction of travel.
 */
function attachmentTangent(
  attachment: unknown,
  ctx: DrawContext,
  endpoint: Point,
  other: Point,
  which: 'start' | 'end',
): Point | null {
  const { nodeId, offset } = (attachment ?? {}) as {
    nodeId?: unknown;
    offset?: Point;
  };
  const node = typeof nodeId === 'string' ? ctx.byId.get(nodeId) : undefined;
  const content = node ? contentOf(node) : null;
  const position = content?.['position'] as Point | undefined;

  if (
    !node ||
    !content ||
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(offset?.x) ||
    !Number.isFinite(offset?.y)
  ) {
    return null;
  }

  const { width, height } = nodeSize(node);
  const rad = (num(content['rotation'], 0) * Math.PI) / 180;
  const toLocal = (point: Point) =>
    rotateBy({ x: point.x - position.x, y: point.y - position.y }, -rad);
  const a = toLocal(endpoint);
  const b = toLocal(other);
  const toward = { x: b.x - a.x, y: b.y - a.y };
  const at = offset as Point;
  const sides = [
    { distance: at.x, direction: { x: -1, y: 0 } },
    { distance: width - at.x, direction: { x: 1, y: 0 } },
    { distance: at.y, direction: { x: 0, y: -1 } },
    { distance: height - at.y, direction: { x: 0, y: 1 } },
  ];
  const nearest = Math.min(...sides.map((it) => it.distance));
  const [best] = sides
    .filter((it) => it.distance <= nearest + 0.5)
    .sort(
      (p, q) =>
        q.direction.x * toward.x +
        q.direction.y * toward.y -
        (p.direction.x * toward.x + p.direction.y * toward.y),
    );
  const outward = rotateBy(best.direction, rad);

  return which === 'start' ? outward : { x: -outward.x, y: -outward.y };
}

function arrowSvg(node: TuNode, ctx: DrawContext): string {
  const content = contentOf(node);
  const geometry = resolveArrowGeometry(node, ctx.byId);
  const position = (content['position'] ?? {}) as Point;
  const local = (point: unknown): Point | null =>
    point &&
    Number.isFinite((point as Point).x) &&
    Number.isFinite((point as Point).y)
      ? (point as Point)
      : null;
  const origin = geometry?.position ?? position;
  const startLocal = geometry?.start ?? local(content['start']);
  const endLocal = geometry?.end ?? local(content['end']);

  if (
    !startLocal ||
    !endLocal ||
    !Number.isFinite(origin?.x) ||
    !Number.isFinite(origin?.y)
  ) {
    return '';
  }

  const start = { x: origin.x + startLocal.x, y: origin.y + startLocal.y };
  const end = { x: origin.x + endLocal.x, y: origin.y + endLocal.y };
  const color = safeColor(content['color'], ARROW_COLOR);
  const strokeWidth = num(content['strokeWidth'], 2);
  const dash =
    content['strokeStyle'] === 'dashed'
      ? ` stroke-dasharray="${fmt(strokeWidth * 4)} ${fmt(strokeWidth * 3)}"`
      : content['strokeStyle'] === 'dotted'
        ? ` stroke-dasharray="${fmt(strokeWidth)} ${fmt(strokeWidth * 2)}"`
        : '';
  let path: string;
  // the point each head points away from
  let beforeEnd: Point = start;
  let afterStart: Point = end;

  if (content['arrowType'] === 'elbow') {
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
    const corner = horizontal
      ? { x: end.x, y: start.y }
      : { x: start.x, y: end.y };

    path = `M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(corner.x)} ${fmt(corner.y)} L ${fmt(end.x)} ${fmt(end.y)}`;
    beforeEnd = corner;
    afterStart = corner;
  } else if (content['arrowType'] === 'curved') {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const control = Math.min(Math.max(distance * 0.35, 24), 180);
    // the web takes the tangents from the stored, unresolved ends
    const stored = (point: Point | null, fallback: Point) =>
      point && Number.isFinite(position?.x) && Number.isFinite(position?.y)
        ? { x: position.x + point.x, y: position.y + point.y }
        : fallback;
    const storedStart = stored(local(content['start']), start);
    const storedEnd = stored(local(content['end']), end);
    const fallback =
      end.x !== start.x
        ? unit({ x: end.x - start.x, y: 0 })
        : unit({ x: end.x - start.x, y: end.y - start.y });
    const t1 = unit(
      attachmentTangent(
        content['startAttachment'],
        ctx,
        storedStart,
        storedEnd,
        'start',
      ) ?? fallback,
    );
    const t2 = unit(
      attachmentTangent(
        content['endAttachment'],
        ctx,
        storedEnd,
        storedStart,
        'end',
      ) ?? fallback,
    );
    const c1 = { x: start.x + t1.x * control, y: start.y + t1.y * control };
    const c2 = { x: end.x - t2.x * control, y: end.y - t2.y * control };

    path = `M ${fmt(start.x)} ${fmt(start.y)} C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(end.x)} ${fmt(end.y)}`;
    beforeEnd = c2;
    afterStart = c1;
  } else {
    path = `M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}`;
  }

  const heads = Array.isArray(content['heads']) ? content['heads'] : ['end'];
  const size = Math.max(ARROW_HEAD, strokeWidth * 2);

  return [
    `<path d="${path}" fill="none" stroke="${escapeXml(color)}" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`,
    heads.includes('end') ? arrowHead(end, beforeEnd, size, color) : '',
    heads.includes('start') ? arrowHead(start, afterStart, size, color) : '',
  ].join('');
}

function nodeSvg(node: TuNode, ctx: DrawContext): string {
  if (node.type === 'arrow') {
    return arrowSvg(node, ctx);
  }

  const content = contentOf(node);
  const position = content['position'] as Point | undefined;

  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return '';
  }

  const size = nodeSize(node);
  const width = Math.max(1, num(size.width, 100));
  const height = Math.max(1, num(size.height, width));
  let body: string;

  switch (node.type) {
    case 'panel':
      body = panelSvg(content, width, height, ctx);
      break;
    case 'note':
      body = noteSvg(content, width, height, ctx);
      break;
    case 'text':
      body = textNodeSvg(content, width, height, ctx);
      break;
    case 'group':
      body = groupSvg(content, width, height, ctx);
      break;
    case 'vector':
    case 'image':
      body = imageSvg(node, content, width, height, ctx);
      break;
    case 'poll':
      body = labelledRect(
        width,
        height,
        `Poll: ${truncateGraphemes(str(content['title']), 60)}`,
        '#ffffff',
        ctx.stats,
      );
      break;
    case 'estimation':
      body = labelledRect(width, height, 'Estimation', '#ffffff');
      break;
    case 'token':
      body = tokenSvg(content, width, height, ctx);
      break;
    default:
      body = labelledRect(width, height, node.type);
  }

  const rotation = num(content['rotation'], 0);
  const transform = rotation
    ? `translate(${fmt(position.x)} ${fmt(position.y)}) rotate(${fmt(rotation)})`
    : `translate(${fmt(position.x)} ${fmt(position.y)})`;

  return body ? `<g transform="${transform}">${body}</g>` : '';
}

const validRegion = (region: Rect) =>
  [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
  region.width >= MIN_PREVIEW_REGION &&
  region.height >= MIN_PREVIEW_REGION;

/**
 * The image size for a region: `width` pixels wide, or narrower so it stays
 * within MAX_PREVIEW_HEIGHT. Null when the region is too small, or so thin
 * that one side would be under a pixel at that scale.
 */
export function previewImageSize(
  region: Rect,
  width: number,
): { width: number; height: number; scale: number } | null {
  if (!validRegion(region)) {
    return null;
  }

  const requested = Math.min(
    MAX_PREVIEW_WIDTH,
    Math.max(1, Math.round(num(width, 1200))),
  );
  const scale = Math.min(
    requested / region.width,
    MAX_PREVIEW_HEIGHT / region.height,
  );
  // floored (with slack for float error) so neither cap is passed
  const pixelWidth = Math.min(
    requested,
    Math.floor(region.width * scale + 1e-6),
  );
  const pixelHeight = Math.min(
    MAX_PREVIEW_HEIGHT,
    Math.floor(region.height * scale + 1e-6),
  );

  if (pixelWidth < 1 || pixelHeight < 1) {
    return null;
  }

  return { width: pixelWidth, height: pixelHeight, scale };
}

// top-level board nodes that show inside the region, in array (z) order
export function previewNodes(nodes: TuNode[], region: Rect): TuNode[] {
  const byId = nodesById(nodes);

  return nodes.filter((node) => {
    if (SKIPPED_TYPES.has(node.type)) {
      return false;
    }

    const bounds = nodeBounds(node, byId);

    return !!bounds && rectsIntersect(bounds, region);
  });
}

/**
 * Pure: the board region as an SVG `opts.width` pixels wide, and how many
 * emoji it drew as placeholders. Text is escaped and colors are allowlisted,
 * so board content can't inject markup.
 */
export function buildBoardPreview(
  nodes: TuNode[],
  region: Rect,
  opts: BoardPreviewOptions,
): { svg: string } & PreviewStats {
  if (!validRegion(region)) {
    throw new Error(
      `Preview region must be at least ${MIN_PREVIEW_REGION}x${MIN_PREVIEW_REGION}`,
    );
  }

  const size =
    opts.height === undefined
      ? previewImageSize(region, opts.width)
      : {
          width: Math.max(1, Math.round(num(opts.width, 1200))),
          height: Math.max(1, Math.round(num(opts.height, 1))),
        };

  if (!size) {
    throw new Error('Preview region is too thin to draw');
  }

  const ctx: DrawContext = {
    assets: opts.assets,
    byId: nodesById(nodes),
    viewerId: opts.viewerId,
    panels: nodes.filter((node) => node.type === 'panel').reverse(),
    budget: { lines: MAX_PREVIEW_TEXT_LINES },
    stats: { emojiPlaceholders: 0 },
  };
  const body = previewNodes(nodes, region)
    .map((node) => nodeSvg(node, ctx))
    .join('\n');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${fmt(region.x)} ${fmt(region.y)} ${fmt(region.width)} ${fmt(region.height)}" preserveAspectRatio="none" font-family="${FONT_FAMILY}">`,
    `<rect x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.width)}" height="${fmt(region.height)}" fill="${BOARD_BACKGROUND}"/>`,
    body,
    '</svg>',
  ].join('\n');

  return { svg, ...ctx.stats };
}

/** buildBoardPreview without the stats. */
export function buildBoardPreviewSvg(
  nodes: TuNode[],
  region: Rect,
  opts: BoardPreviewOptions,
): string {
  return buildBoardPreview(nodes, region, opts).svg;
}

/* ---------- assets ---------- */

// insertion order is recency: a hit is moved to the end
const assetCache = new Map<string, string>();
let assetCacheBytes = 0;

function cacheGet(url: string) {
  const value = assetCache.get(url);

  if (value !== undefined) {
    assetCache.delete(url);
    assetCache.set(url, value);
  }

  return value;
}

function cacheSet(url: string, value: string) {
  if (assetCache.has(url)) {
    assetCacheBytes -= assetCache.get(url)?.length ?? 0;
    assetCache.delete(url);
  }

  assetCache.set(url, value);
  assetCacheBytes += value.length;

  for (const [key, cached] of assetCache) {
    if (
      assetCache.size <= ASSET_CACHE_ENTRIES &&
      assetCacheBytes <= ASSET_CACHE_BYTES
    ) {
      break;
    }

    assetCache.delete(key);
    assetCacheBytes -= cached.length;
  }
}

export function clearPreviewAssetCache() {
  assetCache.clear();
  assetCacheBytes = 0;
}

// the layout decoration allowlist: https://cocomaterial.com only
export const isPreviewAssetUrl = isCocomaterialUrl;

// what is fetched and cached: no query or fragment, so variants of one
// asset url cost one request
function fetchUrlOf(url: string) {
  const parsed = new URL(url);

  return `${parsed.origin}${parsed.pathname}`;
}

// the web app's template art (assets/templates/...), fetched from the
// configured web origin only
function appAssetFetchUrl(url: string): string | { skip: string } {
  const frontend = process.env['FRONTEND_URL'];

  if (!frontend) {
    return { skip: 'app asset without FRONTEND_URL' };
  }

  try {
    const resolved = new URL(url, frontend);

    if (resolved.origin !== new URL(frontend).origin) {
      return { skip: 'app asset outside FRONTEND_URL' };
    }

    return `${resolved.origin}${resolved.pathname}`;
  } catch {
    return { skip: 'app asset without FRONTEND_URL' };
  }
}

function previewFetchUrl(url: string): string | { skip: string } {
  if (isCocomaterialUrl(url)) {
    return fetchUrlOf(url);
  }

  if (isAppTemplateAssetUrl(url)) {
    return appAssetFetchUrl(url);
  }

  return { skip: 'not a https cocomaterial.com url' };
}

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

// external references inside fetched SVG must not reach the renderer
function neutralizeSvgRefs(svg: string) {
  return svg.replace(/(\bhref\s*=\s*)(?:"(?!#)[^"]*"|'(?!#)[^']*')/gi, '$1"#"');
}

class AssetError extends Error {}

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();

  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > MAX_ASSET_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AssetError('too large');
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

async function fetchAsset(url: string, fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(ASSET_TIMEOUT_MS),
    headers: { accept: 'image/svg+xml,image/*' },
  });

  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new AssetError('redirect');
  }

  if (!response.ok) {
    throw new AssetError(`http ${response.status}`);
  }

  if (response.url && response.url !== url && !sameOrigin(response.url, url)) {
    throw new AssetError('redirect');
  }

  const mime = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!ASSET_TYPES.has(mime)) {
    throw new AssetError(`content-type ${mime || 'missing'}`);
  }

  const length = Number(response.headers.get('content-length'));

  if (Number.isFinite(length) && length > MAX_ASSET_BYTES) {
    throw new AssetError('too large');
  }

  const bytes = await readCapped(response);

  if (!bytes.byteLength) {
    throw new AssetError('empty');
  }

  const data =
    mime === 'image/svg+xml'
      ? Buffer.from(neutralizeSvgRefs(Buffer.from(bytes).toString('utf8')))
      : Buffer.from(bytes);

  return `data:${mime};base64,${data.toString('base64')}`;
}

const assetUrls = (nodes: TuNode[]) => [
  ...new Set(
    nodes
      .filter((node) => node.type === 'vector' || node.type === 'image')
      .map((node) => str(contentOf(node)['url']))
      .filter(Boolean),
  ),
];

/**
 * Fetches the art of the vector and image nodes. Only https Cocomaterial urls
 * and the app's assets/templates art (on FRONTEND_URL) are requested; the
 * rest (uploads included) are skipped with a reason.
 */
export async function loadPreviewAssets(
  nodes: TuNode[],
  opts: { fetch?: typeof fetch } = {},
): Promise<{
  assets: Map<string, string>;
  skipped: PreviewSkippedAsset[];
}> {
  const fetchFn = opts.fetch ?? fetch;
  const assets = new Map<string, string>();
  const skipped: PreviewSkippedAsset[] = [];
  // fetch url -> the board urls that share it
  const pending = new Map<string, string[]>();

  for (const url of assetUrls(nodes)) {
    const key = previewFetchUrl(url);
    const cached = typeof key === 'string' ? cacheGet(key) : undefined;

    if (typeof key !== 'string') {
      skipped.push({ url, reason: key.skip });
    } else if (cached !== undefined) {
      assets.set(url, cached);
    } else if (pending.has(key)) {
      pending.get(key)?.push(url);
    } else if (pending.size >= MAX_ASSETS_PER_RENDER) {
      skipped.push({ url, reason: 'too many assets' });
    } else {
      pending.set(key, [url]);
    }
  }

  await Promise.all(
    [...pending].map(async ([key, urls]) => {
      try {
        const dataUri = await fetchAsset(key, fetchFn);

        cacheSet(key, dataUri);
        urls.forEach((url) => assets.set(url, dataUri));
      } catch (error) {
        const reason =
          error instanceof AssetError
            ? error.message
            : error instanceof Error && error.name === 'TimeoutError'
              ? 'timeout'
              : 'fetch failed';

        urls.forEach((url) => skipped.push({ url, reason }));
      }
    }),
  );

  return { assets, skipped };
}

/* ---------- render ---------- */

const RENDER_FONTS = {
  font: {
    loadSystemFonts: true,
    defaultFontFamily: 'DejaVu Sans',
    sansSerifFamily: 'DejaVu Sans',
  },
};

/**
 * Throws when the region is too small or too thin to draw (see
 * previewImageSize). Art that makes the renderer fail is dropped and
 * reported as skipped rather than failing the preview.
 */
export async function renderBoardPreview(
  nodes: TuNode[],
  region: Rect,
  width: number,
  opts: { viewerId?: string; fetch?: typeof fetch } = {},
): Promise<
  {
    png: Buffer;
    skipped: PreviewSkippedAsset[];
    scale: number;
  } & PreviewStats
> {
  const size = previewImageSize(region, width);

  if (!size) {
    throw new Error(
      `Preview region must be at least ${MIN_PREVIEW_REGION}x${MIN_PREVIEW_REGION} and not too thin to draw within ${MAX_PREVIEW_WIDTH}x${MAX_PREVIEW_HEIGHT} pixels`,
    );
  }

  const visible = previewNodes(nodes, region);
  const { assets, skipped } = await loadPreviewAssets(visible, opts);
  const build = (art: Map<string, string>) =>
    buildBoardPreview(nodes, region, {
      width: size.width,
      height: size.height,
      assets: art,
      viewerId: opts.viewerId,
    });
  // the same text either way, so the same emoji count
  const built = build(assets);
  const render = (art: Map<string, string>) =>
    renderSvgToPng(art === assets ? built.svg : build(art).svg, RENDER_FONTS);
  let png: Buffer;

  try {
    png = await render(assets);
  } catch (error) {
    if (
      !(error instanceof PreviewRenderError && error.crashed) ||
      !assets.size
    ) {
      throw error;
    }

    // some fetched svg trips the renderer; placeholders instead
    png = await render(new Map());
    skipped.push(
      ...[...assets.keys()].map((url) => ({
        url,
        reason: 'could not be rendered',
      })),
    );
  }

  return {
    png,
    skipped,
    scale: size.width / region.width,
    emojiPlaceholders: built.emojiPlaceholders,
  };
}
