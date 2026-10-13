import { DEFAULT_FONT_SIZE } from './text-presets.js';

// DOM-free and deliberately rough; calibrated against the web app in Phase 3
const CHAR_WIDTH_EM = 0.55;
const DEFAULT_LINE_HEIGHT = 1.2;
const BLOCK_MARGIN = 4;
const SAFETY = 1.1;

const TAG_FONT_SIZES: Record<string, number> = {
  h1: 320,
  h2: 160,
  h3: 80,
};

// note auto-shrink (note-height-calculator.service.ts)
const NOTE_MAX_FONT = 46;
const NOTE_PADDING = 18;
const NOTE_NAME_HEIGHT = 22;
const NOTE_LINE_HEIGHT = 1.1;

const PANEL_PADDING = 12;
const PANEL_BORDER = 1;

export interface TextEstimate {
  height: number;
  lines: number;
  maxFontPx: number;
}

interface Block {
  // 0 when the base size or line height applies
  fontPx: number;
  lineHeight: number;
  // character count of every word, per line
  lines: number[][];
}

// linear: no pattern rescans past the next tag
const TAG_RE = /<(\/?)(p|h1|h2|h3|li)\b[^<>]*>/gi;
const FONT_SIZE_RE = /font-size:\s*(\d+(?:\.\d+)?)px/gi;
const LINE_HEIGHT_RE = /line-height:\s*(\d+(?:\.\d+)?)(?:\s*[;"']|$)/gi;

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

interface Tag {
  close: boolean;
  tag: string;
  start: number;
  end: number;
}

// each block runs from an opening tag to the next closing tag of its kind
function blockHtml(html: string): { tag: string; html: string }[] {
  const tags = [...html.matchAll(TAG_RE)].map((match): Tag => ({
    close: match[1] === '/',
    tag: match[2].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const closes = new Map<string, Tag[]>();
  const next = new Map<string, number>();
  const blocks: { tag: string; html: string }[] = [];
  let from = 0;

  tags
    .filter((tag) => tag.close)
    .forEach((tag) => {
      const list = closes.get(tag.tag) ?? [];

      list.push(tag);
      closes.set(tag.tag, list);
    });

  tags.forEach((open) => {
    if (open.close || open.start < from) {
      return;
    }

    const candidates = closes.get(open.tag) ?? [];
    let index = next.get(open.tag) ?? 0;

    while (index < candidates.length && candidates[index].start < open.end) {
      index++;
    }

    next.set(open.tag, index);

    const close = candidates[index];

    if (close) {
      blocks.push({ tag: open.tag, html: html.slice(open.end, close.start) });
      from = close.end;
    }
  });

  return blocks;
}

function textLines(html: string): string[] {
  return html.split(/<br\s*\/?>/i).map((part) =>
    part
      .replace(/<[^<>]*>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) =>
        name.startsWith('#')
          ? // one character; only its width matters here
            'x'
          : (ENTITIES.get(name.toLowerCase()) ?? entity),
      ),
  );
}

const largest = (re: RegExp, html: string) =>
  Math.max(0, ...[...html.matchAll(re)].map((match) => Number(match[1])));

const wordLengths = (text: string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => [...word].length);

// parsed once, then measured at any font size
function parse(html: string): Block[] {
  const found = blockHtml(html);
  const blocks = found.length || !html.trim() ? found : [{ tag: 'p', html }];

  return blocks.map((block) => ({
    fontPx: largest(FONT_SIZE_RE, block.html) || TAG_FONT_SIZES[block.tag] || 0,
    lineHeight: largest(LINE_HEIGHT_RE, block.html),
    lines: textLines(block.html).map(wordLengths),
  }));
}

function wrappedLines(words: number[], charWidth: number, width: number) {
  if (!words.length || width <= 0) {
    return 1;
  }

  const space = charWidth;
  let lines = 1;
  let current = 0;

  for (const length of words) {
    const wordWidth = length * charWidth;

    if (wordWidth > width) {
      // a word longer than the line breaks anywhere
      if (current > 0) {
        lines++;
      }

      const parts = Math.ceil(wordWidth / width);

      lines += parts - 1;
      current = wordWidth - (parts - 1) * width;
    } else if (current === 0) {
      current = wordWidth;
    } else if (current + space + wordWidth <= width) {
      current += space + wordWidth;
    } else {
      lines++;
      current = wordWidth;
    }
  }

  return lines;
}

function measure(
  blocks: Block[],
  innerWidth: number,
  baseFontPx: number,
  baseLineHeight: number,
): TextEstimate {
  let height = 0;
  let lines = 0;
  let maxFontPx = 0;

  for (const block of blocks) {
    const fontPx = block.fontPx || baseFontPx;
    const lineHeight = block.lineHeight || baseLineHeight;
    const blockLines = block.lines.reduce(
      (sum, words) =>
        sum + wrappedLines(words, fontPx * CHAR_WIDTH_EM, innerWidth),
      0,
    );

    lines += blockLines;
    height += blockLines * fontPx * lineHeight + BLOCK_MARGIN;
    maxFontPx = Math.max(maxFontPx, fontPx);
  }

  return { height: Math.ceil(height * SAFETY), lines, maxFontPx };
}

export function estimateHtmlHeight(
  html: string,
  innerWidth: number,
): TextEstimate {
  return measure(
    parse(html),
    innerWidth,
    DEFAULT_FONT_SIZE,
    DEFAULT_LINE_HEIGHT,
  );
}

// text nodes have a 1px transparent border
export function estimateTextNodeHeight(html: string, width: number): number {
  return estimateHtmlHeight(html, width - 2).height;
}

// distance from a panel's top edge to the bottom of its text
export function estimatePanelTextBottom(html: string, width: number): number {
  const inset = PANEL_PADDING + PANEL_BORDER;

  return inset + estimateHtmlHeight(html, width - inset * 2).height;
}

// the font size a note shrinks its text to, like the web auto-shrink
export function estimateNoteFontPx(
  html: string,
  width: number,
  height: number,
): number {
  const innerWidth = width - NOTE_PADDING * 2;
  const available = height - NOTE_NAME_HEIGHT - NOTE_PADDING / 2;
  const blocks = parse(html);

  for (let fontPx = NOTE_MAX_FONT; fontPx >= 1; fontPx--) {
    const text = measure(blocks, innerWidth, fontPx, NOTE_LINE_HEIGHT);

    if (text.height < available) {
      return Math.max(1, fontPx - 1);
    }
  }

  return 1;
}
