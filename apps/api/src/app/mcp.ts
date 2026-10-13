import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import { DrizzleQueryError } from 'drizzle-orm';
import {
  boundsOfNodes,
  BUILTIN_TEMPLATES,
  type CocomaterialApiListVectors,
  type CocomaterialApiVector,
  type CocomaterialTag,
  expandLayout,
  isNotesHidden,
  isSettings,
  LAYOUT_EXAMPLES,
  LAYOUT_SIZES,
  layoutSpecSchema,
  lintNodes,
  maskNodesForViewer,
  MAX_LAYOUT_DECORATIONS,
  nodeBounds,
  nodesById,
  presetHtml,
  type Rect,
  type StateActions,
  TEMPLATE_LIMITS,
  TEXT_PRESETS,
  type TextPreset,
  type TuNode,
  unionRects,
  withDefaultUserSettings,
} from '@tapiz/board-commons';
import { Client } from './client.js';
import type { Server } from './server.js';
import db from './db/index.js';
import { authenticateApiToken } from './authenticate-api-token.js';
import { logError } from './log-error.js';
import type { ActionRejection } from './validation.js';
import { insertTemplateAsMcpUser } from './layout-service.js';
import {
  MIN_PREVIEW_REGION,
  previewImageSize,
  previewNodes,
  renderBoardPreview,
} from './board-preview.js';
import {
  deleteTemplateAsUser,
  getTemplateWithData,
  isBuiltinTemplateId,
  listBuiltinTemplates,
  listTemplateSummaries,
  loadBuiltinTemplate,
  requireTemplate,
  saveTemplateFromBoard,
  TEMPLATE_QUOTAS,
  TemplateError,
} from './template-service.js';

export type McpUser = {
  id: string;
  name: string;
  email: string | null;
};
type CocomaterialNodeInput = {
  url: string;
  width: number;
  height: number;
  center: {
    x: number;
    y: number;
  };
  layer: 0 | 1;
  rotation: number;
  kind?: 'vector' | 'image';
};

const boardIdSchema = z.uuid();
const nodeSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  content: z.record(z.string(), z.unknown()),
  children: z.array(z.unknown()).optional(),
});
const actionSchema = z.object({
  op: z.enum(['add', 'remove', 'patch']),
  data: z.object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(255),
    content: z.unknown().optional(),
  }),
  parent: z.string().min(1).max(255).optional(),
  position: z.number().int().optional(),
});
const cocomaterialTagsSchema = z.array(z.string().min(1).max(255)).max(20);
const cocomaterialPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
const cocomaterialUrlSchema = z
  .url()
  .max(2000)
  .refine((url) => {
    try {
      return new URL(url).hostname === 'cocomaterial.com';
    } catch {
      return false;
    }
  }, 'URL must be from cocomaterial.com');
const cocomaterialNodeSchema = z.object({
  boardId: boardIdSchema.describe('Tapiz board UUID'),
  url: cocomaterialUrlSchema.describe(
    'Cocomaterial asset URL, usually the svg or gif field returned by search_cocomaterial_vectors',
  ),
  kind: z
    .enum(['vector', 'image'])
    .optional()
    .describe(
      'Optional explicit node type. SVG defaults to vector; other URLs default to image.',
    ),
  width: z.number().positive().default(150).describe('Node width'),
  height: z.number().positive().default(150).describe('Node height'),
  center: cocomaterialPositionSchema.describe(
    'Board position for the center of the asset',
  ),
  layer: z
    .union([z.literal(0), z.literal(1)])
    .default(1)
    .describe(
      'Board layer: 0 for participant content, 1 for edit/template content. Only board admins can add to layer 1; use 0 otherwise.',
    ),
  rotation: z.number().default(0).describe('Node rotation in degrees'),
});

const BUILTIN_TEMPLATE_IDS = BUILTIN_TEMPLATES.map((it) => it.id).join(', ');

// built-in ids never reach a uuid-typed query
const templateIdSchema = z
  .union([z.uuid(), z.string().regex(/^builtin:[a-z0-9-]{1,64}$/)])
  .describe(
    `Saved template UUID, or a built-in template id (${BUILTIN_TEMPLATE_IDS})`,
  );
const insertOriginSchema = z
  .object({ x: z.number(), y: z.number() })
  .optional()
  .describe(
    "Board position of the inserted content's top-left; default: next to the existing content",
  );
const insertPlacementSchema = z
  .enum(['right', 'below'])
  .default('right')
  .describe('Where the content goes without an origin');
const insertLayerSchema = z
  .enum(['auto', 'asStored'])
  .default('auto')
  .describe(
    'auto: layer 1 panels for board admins, layer 0 for everyone else; asStored: layer 1 panels, admins only',
  );
const insertDryRunSchema = z
  .boolean()
  .default(false)
  .describe('Compute the result without writing anything');

const COCOMATERIAL_API_URL = 'https://cocomaterial.com/api';

const PRESET_EXAMPLE = presetHtml({ preset: 'heading', text: 'Went well' });

// e.g. "heading 40px bold": the sizes create_layout and the editor use
const PRESET_TABLE = (Object.keys(TEXT_PRESETS) as TextPreset[])
  .map((name) => {
    const { fontSize, lineHeight, bold, color } = TEXT_PRESETS[name];

    return [
      name,
      fontSize ? `${fontSize}px` : '24px (default, no font-size)',
      `line-height ${lineHeight}`,
      bold ? 'bold' : '',
      color ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  })
  .join('; ');

const TEMPLATE_GUIDANCE = `To reuse a finished layout, save it with save_board_as_template (nodeIds = the refs values create_layout returned, or omit them for the whole board) and place copies on any board with insert_template; list_templates and get_template show the built-in templates and the personal and team templates the user can read. Inserted copies get fresh ids, notes owned by the API token user with votes and emojis cleared, and the same layer policies and placement as create_layout. For a standard movie, starfish, sailboat, mad-sad-glad or stop-start-continue retro, insert the built-in template; use create_layout only for custom or themed variants, other formats, or when you need cells with note slots (cells, freeSlots). Built-in ids: ${BUILTIN_TEMPLATE_IDS}. Their labels are ready to use, so relabelling is optional; to change one, call get_template with includeData: true to see each ref's type and text (the labels are its text nodes and panel texts), then patch the node refs[ref] from the insert_template result with apply_board_actions. Check the result with preview_board.`;

const LAYOUT_GUIDANCE =
  'For lanes, columns, kanban boards, grids, 2x2 quadrants and rings of cells (custom retrospectives, brainstorms, prioritisation matrices), call create_layout instead of hand-building panels: it sizes every panel around 300x300 note slots, keeps notes below the header band, never sets panel color, places the layout next to the existing content, chooses layers for the user, and returns freeSlots (top-left positions of empty note slots) for follow-up notes. For a standard movie, starfish, sailboat, mad-sad-glad or stop-start-continue retro, insert the built-in template; use create_layout only for custom or themed variants, other formats, or when you need cells with note slots (cells, freeSlots). For custom or themed retros (a space mission, a starfish around your own art), use kind "radial" around a centre illustration, per-cell style (shapes, colours, borders, frameless lanes over art) and decorations with Cocomaterial art found with search_cocomaterial_vectors. Use lint_board to check hand-built layouts.';

const PREVIEW_GUIDANCE =
  'preview_board renders the board, a region or a set of nodes as a PNG image on the server, as the user would see it. Call it after creating or editing a layout, especially freeform or artistic ones (decorations, radial rings, hand-placed art), look at the image and iterate: move or resize what overlaps, is clipped or looks unbalanced, then preview again.';

export const TAPIZ_MCP_INSTRUCTIONS = [
  'Tapiz is an infinite collaborative board. Read the board before editing existing content.',
  'Use board coordinates in content.position, not browser screen coordinates. Do not use content.layer as z-index: Tapiz uses layer 0 for participant board content such as notes/text and layer 1 for edit/template content such as panels. Do not invent arbitrary layers such as layer 2; validation only accepts layers 0 and 1, and board-mode tools like area selection are designed around those supported layer roles. Layer 1 is the board edit mode and only board admins (including team admins) can add, change or remove layer-1 nodes; for any other user these actions are rejected, along with the rest of their batch, so use layer 0 when the API token user is not a board admin.',
  'Visual depth/z-index comes from node order in the board array: later sibling nodes render above earlier sibling nodes. To put an element in front of or behind another element, move it in the array with apply_board_actions position/order rather than changing content.layer.',
  'Use apply_board_actions for multi-node edits so related changes are validated and persisted as one realtime batch.',
  "When the board settings have notesHidden set to true, notes of other users are returned as blank cards with empty text, drawing and emojis and no comments, admins included; you can only add notes owned by the API token user, and other users' notes can only be moved or resized (no text, votes, color, comments or removal) until a board admin reveals them.",
  'Choose node types deliberately: notes are editable/votable sticky content; panels are visual lanes/backgrounds; groups are movable/votable clusters; text is standalone labels/instructions; arrows connect nodes; vectors/images are visual assets; polls, estimation, timers, comments, settings, and users are specialized workflow/runtime nodes.',
  'For post-it workflows such as retrospectives, design lanes around the real default note size of 300x300. Make lanes wide/tall enough for multiple 300x300 notes, leave real empty space in each lane, reserve a header band inside panels, and do not place notes over panel labels or instructions.',
  'Do not set panel content.color for lanes that contain notes unless you intentionally want to recolor every note inside that panel. Tapiz notes inside a panel use the panel color instead of their own note color.',
  'Note text renders black and notes can show an author/footer area, so use light high-contrast note colors and make notes tall enough that content is not hidden by footer UI.',
  `For compact labels in text or panel nodes, avoid raw h1/h2/h3 rich-text tags because Tapiz canvas heading styles render very large. Use paragraph/span markup with explicit font-size and line-height, bold through <strong>, for example ${PRESET_EXAMPLE} (text presets: ${PRESET_TABLE}).`,
  'After creating a layout, verify it in the web app with Playwright or a browser: check visible text, bounding boxes, layering, and console warnings; without a browser, call preview_board for a rendered image and iterate on what you see.',
  LAYOUT_GUIDANCE,
  PREVIEW_GUIDANCE,
  TEMPLATE_GUIDANCE,
  'Write tools validate a batch in order, so later actions can patch, remove or comment on nodes added earlier in the same batch. A batch is all-or-nothing: the result status is applied or rejected (a read-only board rejects every non-user action with code read_only), and rejected lists each failed action with index, code, message and a hint on how to fix it. get_board returns viewer (userId, isAdmin, readOnly, notesHidden) and a compact format for layout work.',
].join(' ');

const BOARD_NODE_TYPE_GUIDANCE =
  'Node type guidance: note = editable/votable sticky idea card and requires text, votes, emojis, drawing, ownerId, width, height, color, position, and layer on add; use layer 0 for participant notes; user-created notes default to about 300x300, so lane layouts should reserve space for multiple 300x300 notes; use light high-contrast note colors because note text is black, and give notes enough height for content plus footer/author UI. panel = visual background/lane/frame below notes; use layer 1 for template/edit panels; reserve a header band and keep notes below it; avoid panel content.color for lanes containing notes because it overrides note colors inside the panel. group = movable/votable semantic cluster, not a decorative column; text = standalone label/instructions; arrow = connector with local endpoints and optional node-local attachments; vector/image = external visual asset; poll/estimation/timer/comment/settings/user = specialized workflow or runtime nodes to preserve unless explicitly requested.';

const BOARD_RICH_TEXT_GUIDANCE = `Rich text caution: raw h1/h2/h3 tags use large canvas template styles. For compact MCP-created text or panel labels, use p/span markup with explicit font-size and line-height, bold through <strong>, e.g. ${PRESET_EXAMPLE}; text presets: ${PRESET_TABLE}. Then verify in the browser.`;

const BOARD_BATCH_EDIT_GUIDANCE =
  'For lanes, grids and quadrants, prefer create_layout, which sizes and places them for you. For other multi-node layouts, prefer apply_board_actions over repeated single-node calls. Use board coordinates and explicit width/height. Do not create arbitrary foreground layers such as layer 2; place participant notes/text on layer 0 and edit/template panels on layer 1. Unsupported layers are rejected by validation, and layer-1 changes from users who are not board admins reject the whole batch. For visual stacking, use board array order: later sibling nodes render above earlier sibling nodes, so place panels before notes and move nodes in the array when you need a different depth. For lanes, make panels wide and tall enough for the seed notes plus at least a few empty 300x300 post-it slots, and leave visible gaps between note cards. Actions are validated in order: later actions may patch, remove, or comment on nodes added earlier in the same batch. The batch is all-or-nothing; `rejected` lists index, code, message and hint, and the other actions are reported as batch_aborted.';

const { NOTE, SLOT_GAP, PAD } = LAYOUT_SIZES;

const SAVE_TEMPLATE_DESCRIPTION = [
  'Save nodes of a board as a reusable template, for the API token user (scope "personal", default) or for a team (scope "team": teamId, or else the board\'s team; the user must be a member of that team).',
  'nodeIds: pass the refs values create_layout returned, or node ids from get_board; omit nodeIds to save the whole board. With includeContained (default true) the nodes lying inside a selected panel or group come along. Unknown nodeIds fail the call.',
  `Only panel, text, note, group, arrow, vector and image nodes are saved. Runtime nodes (user, settings, timer) are skipped silently; other types (poll, estimation, token, …), other users' notes the user cannot read (while notes are hidden, or whose text its owner made private), and assets that only live on this board (data: URLs, uploads) are listed in dropped with a reason. Arrows attached to a node outside the selection keep their endpoints but lose that attachment (detachedArrows). Comments, votes, emojis and note owners are not kept. Template refs are usually the source node ids. Limits: ${TEMPLATE_LIMITS.maxNodes} nodes, ${TEMPLATE_QUOTAS.account} personal templates per account, ${TEMPLATE_QUOTAS.team} per team.`,
  'Returns { template: { id, name, description, scope, nodeCount, width, height, createdBy, createdAt, updatedAt, canEdit }, dropped: [{ id, type, reason }], detachedArrows, lint }. Place it with insert_template.',
].join(' ');

const INSERT_TEMPLATE_DESCRIPTION = [
  'Insert a copy of a saved or built-in template (see list_templates) into a board, with fresh node ids. Arrows attached inside the template are re-pointed to the new nodes, notes are owned by the API token user with votes and emojis cleared.',
  `Built-in templates (${BUILTIN_TEMPLATE_IDS}) are the ready-made retros of the web template selector, the first choice for a standard retro of that kind. Their refs are positional (n0, n1, …) and their labels are ready to use; to relabel, call get_template with includeData: true to see each ref's type and text (the labels are its text nodes and panel texts), then patch refs[ref] with apply_board_actions, and check it with preview_board. Their headings are kept as they are, so raw_heading is not reported for them.`,
  'origin, placement, layer and dryRun work as in create_layout: without origin the copy goes 400px right of (or below) the existing content; layer "auto" (default) keeps the stored layers for board admins and puts everything on layer 0 for anyone else (layerCoerced: true); "asStored" is rejected for users who are not board admins. Inserting twice gives two independent copies.',
  'Returns { status: applied | dry_run | rejected, origin, bounds, nodeCount, layerCoerced, refs (template ref -> new node id), lint, rejected, nodes (dry run only) }.',
].join(' ');

const CREATE_LAYOUT_DESCRIPTION = [
  'Create a ready-made layout of labelled panels with 300x300 note slots in one call: kind "columns" (lanes side by side, at most 12), "grid" (gridColumns per row, default about square), "quadrants" (exactly 4 cells: top-left, top-right, bottom-left, bottom-right, with optional axes captions in reading order: { x: [left, right], y: [top, bottom] }, e.g. y: ["High impact", "Low impact"] puts high impact on the top row) or "radial" (2 to 8 cells on a ring, the first at the top and the rest clockwise, around the centre decorations; the ring grows so no cell overlaps another or the centre art).',
  `Sizing is automatic: each cell holds noteColumns (default 2, max 4) columns of ${NOTE}x${NOTE} notes, ${SLOT_GAP}px apart, inside ${PAD}px padding, so a cell is ${2 * PAD} + n*${NOTE} + (n-1)*${SLOT_GAP} wide; the header band fits the title and subtitle; every cell has the same size, room for at least capacity notes (default 6, radial 4) and always at least one empty row after the seed notes. Cell notes are seeded as notes in reading order; title and description become text above the cells.`,
  "Panels never get a color (it would recolour the notes inside). Per-cell style: { shape: rect | rounded | pill, backgroundColor, borderColor (#rrggbb), borderWidth (0-20), frameless (a transparent lane without a border, e.g. over art) }; style.backgroundColor wins over the older cell backgroundColor. Notes use noteColor, or else the user's default note colour.",
  `decorations (at most ${MAX_LAYOUT_DECORATIONS}): Cocomaterial illustrations placed with the layout, { url, anchor, width, height, rotation?, offset?: { x, y } }. url must be an https://cocomaterial.com/... asset url, usually the svg field of a search_cocomaterial_vectors result (list_cocomaterial_tags with a query such as "sea" finds tag slugs); other hosts are rejected. .svg urls become vector nodes, anything else an image node. anchor: "center" (the middle of the cells; radial: the ring centre, sized into the ring), "behind" (the middle of the cells, below every panel), "top-left" | "top-right" | "bottom-left" | "bottom-right" (a sticker centred on that corner of the whole layout, title included) or { cell, corner } (a corner, or "center", of one cell, cells numbered from 0). offset moves it from the anchor in board pixels; width and height should follow the art's aspectRatio from search_cocomaterial_vectors. Decorations count in the layout bounds; the layout title, description and axis captions stay above them, but a sticker on a cell's top corner can cover that cell's header title, so prefer a bottom corner or an offset that moves it outward.`,
  'origin is the board position of the layout\'s top-left; without it the layout goes 400px right of (placement "right") or below (placement "below") the existing content. layer "auto" (default): board admins get the panels, texts and decorations on layer 1, with the panels inserted behind existing notes, anyone else gets everything on layer 0 (layerCoerced: true); "asStored" keeps them on layer 1 and is rejected for users who are not board admins. dryRun: true writes nothing and reports where every node would go.',
  "Returns { status: applied | dry_run | rejected, origin, bounds, nodeCount, layerCoerced, refs (template ref -> node id), lint (advisory issues), rejected, nodes (dry run only), cells: [{ ref, title, panelId, bounds, noteIds, freeSlots }] } in board coordinates. To add notes later, put 300x300 notes at a cell's freeSlots positions (top-left corners) on layer 0 with apply_board_actions. Check the result with preview_board.",
  'Example, a 3-column retro: { "boardId": "…", "layout": { "kind": "columns", "title": "Sprint 42 retro", "cells": [ { "title": "Went well", "notes": ["Pairing on the API", "Fast reviews"] }, { "title": "To improve", "notes": ["Flaky e2e tests", "Late scope changes"] }, { "title": "Actions", "subtitle": "Owner and date", "notes": ["Fix the e2e flakes", "Freeze scope on Wednesday"] } ] } }.',
  `Example, a custom starfish retro around Cocomaterial art: { "boardId": "…", "layout": ${JSON.stringify(LAYOUT_EXAMPLES.starfish)} }.`,
  `Text presets used for headers, for hand-built text too: ${PRESET_TABLE}. Markup example: ${PRESET_EXAMPLE}.`,
].join(' ');

const PREVIEW_MAX_COORD = 10_000_000;

const previewRegionSchema = z
  .union([
    z.literal('content'),
    // bounded so an absurd rectangle can't reach the renderer
    z.object({
      x: z.number().min(-PREVIEW_MAX_COORD).max(PREVIEW_MAX_COORD),
      y: z.number().min(-PREVIEW_MAX_COORD).max(PREVIEW_MAX_COORD),
      width: z.number().min(MIN_PREVIEW_REGION).max(PREVIEW_MAX_COORD),
      height: z.number().min(MIN_PREVIEW_REGION).max(PREVIEW_MAX_COORD),
    }),
    z.object({
      nodeIds: z.array(z.string().min(1).max(255)).min(1).max(500),
    }),
  ])
  .default('content')
  .describe(
    '"content": every positioned node plus an 80px margin; { x, y, width, height }: a board rectangle; { nodeIds }: these nodes (e.g. the refs values create_layout returned) plus an 80px margin',
  );

const EMOJI_PLACEHOLDER_NOTE =
  'emoji are shown as placeholders in previews; they display normally in the web app';

const PREVIEW_BOARD_DESCRIPTION = [
  "Render a board, a board rectangle or a set of nodes as a PNG image on the server, as the API token user sees it (while notes are hidden, other users' notes are blank cards). Use it to check a layout after create_layout, insert_template or hand-built edits, especially freeform or artistic ones, and iterate on what you see.",
  'The image is width pixels wide (400-1600, default 1200) and at most 4800 pixels tall; a tall region renders narrower, and a region too thin to draw at that size (e.g. content stretched by one far-away node) returns only the legend with a message: preview a rectangle or nodeIds instead. Panels, notes, text, groups, arrows, drawings, vectors and images are drawn in board order with their rotation; text sizes follow the editor closely but not exactly.',
  "Only https://cocomaterial.com art and the web app's own template art (assets/templates/...) are fetched; other images (uploads included) are labelled placeholder boxes and listed in skippedAssets with a reason.",
  `Emoji: ${EMOJI_PLACEHOLDER_NOTE}. The server has no emoji font, so each emoji is a small grey rounded square, counted in emojiPlaceholders; do not remove or replace emoji because of how they look in a preview.`,
  'Returns an image item and a text legend { region (board coordinates of the image), scale (image pixels per board unit), image: { width, height }, nodeCount, skippedAssets: [{ url, reason }], emojiPlaceholders (emoji drawn as placeholders), emojiNote (when emojiPlaceholders > 0), missingNodeIds }; board position = region.x + pixel x / scale. An empty board or region returns only the legend, with a message.',
].join(' ');

class McpSocket {
  constructor(private server: Server) {}

  on() {
    return this;
  }

  emit() {
    return true;
  }

  to(boardId: string) {
    return this.server.io.to(boardId);
  }

  join() {
    return;
  }

  leave() {
    return;
  }

  disconnect() {
    return this;
  }
}

// The SDK sends a throwing tool's error.message to the client, and drizzle's
// includes the SQL and its params; send the driver's message instead. A
// TemplateError's message is meant for the caller; its issues are added to it.
export function hideQueryDetails<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof DrizzleQueryError) {
        logError(e);

        // no cause: it would carry the query and its params to the caller
        // eslint-disable-next-line preserve-caught-error
        throw new Error(e.cause?.message ?? 'Database error');
      }

      if (e instanceof TemplateError && e.issues?.length) {
        const issues = e.issues
          .slice(0, 10)
          .map((it) => `${it.path.join('.') || 'template'}: ${it.message}`)
          .join('; ');

        // eslint-disable-next-line preserve-caught-error
        throw new Error(`${e.message}: ${issues}`);
      }

      throw e;
    }
  };
}

function textResult(content: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(content, null, 2),
      },
    ],
  };
}

function isAllowedOrigin(origin: string | undefined) {
  if (!origin) {
    return true;
  }

  const allowedOrigins = new Set(
    [process.env['FRONTEND_URL']].filter((it): it is string => !!it),
  );

  try {
    const url = new URL(origin);

    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return true;
    }
  } catch {
    return false;
  }

  return allowedOrigins.has(origin);
}

async function fetchCocomaterial<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${COCOMATERIAL_API_URL}${path}`, init);

  if (!response.ok) {
    throw new Error(`Cocomaterial request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

// the tag list is large and rarely changes; one fetch serves 10 minutes
const COCOMATERIAL_TAGS_TTL_MS = 10 * 60 * 1000;
// every caller waits on the shared request, so a hang must fail fast
const COCOMATERIAL_TAGS_TIMEOUT_MS = 10_000;
let cocomaterialTags: { tags: CocomaterialTag[]; expiresAt: number } | null =
  null;
let cocomaterialTagsRequest: Promise<CocomaterialTag[]> | null = null;

export function clearCocomaterialTagCache() {
  cocomaterialTags = null;
  cocomaterialTagsRequest = null;
}

// an unexpected body throws, like a failed request, so it is not cached
async function requestCocomaterialTags(): Promise<CocomaterialTag[]> {
  const tags = await fetchCocomaterial<unknown>('/tags', {
    signal: AbortSignal.timeout(COCOMATERIAL_TAGS_TIMEOUT_MS),
  });

  if (!Array.isArray(tags)) {
    throw new Error('Unexpected Cocomaterial tags response');
  }

  return tags as CocomaterialTag[];
}

async function fetchCocomaterialTags(): Promise<CocomaterialTag[]> {
  if (cocomaterialTags && cocomaterialTags.expiresAt > Date.now()) {
    return cocomaterialTags.tags;
  }

  // concurrent calls share one request; a failure is not cached
  const request = (cocomaterialTagsRequest ??= requestCocomaterialTags());

  try {
    const tags = await request;

    if (cocomaterialTagsRequest === request) {
      cocomaterialTags = {
        tags,
        expiresAt: Date.now() + COCOMATERIAL_TAGS_TTL_MS,
      };
    }

    return tags;
  } finally {
    if (cocomaterialTagsRequest === request) {
      cocomaterialTagsRequest = null;
    }
  }
}

/**
 * Tag slugs, sorted, whose slug or name contains the query (any case); total
 * counts every match, tags holds at most limit of them.
 */
export function filterCocomaterialTags(
  tags: CocomaterialTag[],
  query: string | undefined,
  limit: number,
) {
  const needle = query?.trim().toLowerCase();
  const slugs = [
    ...new Set(
      tags
        .filter(
          (tag) =>
            typeof tag?.slug === 'string' &&
            tag.slug &&
            (!needle ||
              tag.slug.toLowerCase().includes(needle) ||
              (typeof tag.name === 'string' &&
                tag.name.toLowerCase().includes(needle))),
        )
        .map((tag) => tag.slug),
    ),
  ].sort();
  const returned = slugs.slice(0, limit);

  return {
    total: slugs.length,
    returned: returned.length,
    tags: returned,
    truncated: returned.length < slugs.length,
  };
}

const SVG_TAG_RE = /<svg\b[^>]*>/i;

const svgAttr = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];

/**
 * width / height of an svg from its root viewBox, else its width and height
 * attributes (any unit); null when neither gives a positive size.
 */
export function svgAspectRatio(svg: string | null | undefined): number | null {
  const tag = svg ? SVG_TAG_RE.exec(svg)?.[0] : undefined;

  if (!tag) {
    return null;
  }

  const viewBox = svgAttr(tag, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const [width, height] =
    viewBox?.length === 4
      ? viewBox.slice(2)
      : [svgAttr(tag, 'width'), svgAttr(tag, 'height')].map((it) =>
          parseFloat(it ?? ''),
        );

  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? Math.round((width / height) * 1000) / 1000
    : null;
}

export function compactCocomaterialVector(vector: CocomaterialApiVector) {
  return {
    id: vector.id,
    name: vector.name,
    tags: vector.tags,
    url: vector.url,
    svg: vector.svg,
    gif: vector.gif,
    coloredSvg: vector.coloredSvg,
    coloredGif: vector.coloredGif,
    aspectRatio: svgAspectRatio(vector.svgContent),
  };
}

export function createCocomaterialNodeAction(
  input: CocomaterialNodeInput,
): StateActions {
  const type =
    input.kind ??
    (input.url.toLowerCase().endsWith('.svg') ? 'vector' : 'image');

  return {
    op: 'add',
    data: {
      id: randomUUID(),
      type,
      content: {
        url: input.url,
        width: input.width,
        height: input.height,
        position: {
          x: input.center.x - input.width / 2,
          y: input.center.y - input.height / 2,
        },
        rotation: input.rotation,
        layer: input.layer,
      },
    },
  };
}

export async function runAsMcpBoardClient<T>(
  server: Server,
  user: McpUser,
  boardId: string,
  callback: (client: Client) => Promise<T>,
) {
  const socket = new McpSocket(server) as unknown as Socket;
  const client = new Client(socket, server, {
    id: user.id,
    name: user.name,
    isGuest: false,
    sessionId: null,
  });

  server.clients.push(client);

  try {
    await client.joinBoard(boardId);

    if (client.boardId !== boardId) {
      throw new Error('Unable to join board with this API token');
    }

    return await callback(client);
  } finally {
    client.close();
    server.clientClose(client);
  }
}

export type McpWriteStatus = 'applied' | 'partial' | 'rejected';

export interface McpWriteResult {
  status: McpWriteStatus;
  appliedActions: StateActions[];
  rejected: ActionRejection[];
  board?: TuNode[];
}

// partial: some board changes went through and others were dropped. Batches
// are all-or-nothing and a read-only board drops every non-user action, so
// MCP batches never produce it today
export function writeStatus(
  applied: StateActions[],
  rejected: ActionRejection[],
): McpWriteStatus {
  if (!rejected.length) {
    return 'applied';
  }

  return applied.some((it) => it.data.type !== 'user') ? 'partial' : 'rejected';
}

export async function applyBoardActionsAsMcpUser(
  server: Server,
  user: McpUser,
  boardId: string,
  actions: StateActions[],
  opts: { includeBoard?: boolean } = {},
): Promise<McpWriteResult> {
  return runAsMcpBoardClient(server, user, boardId, async (client) => {
    const { applied, rejected } = await client.applyStateActions(actions, {
      sequential: true,
      rejectDuplicateIds: true,
    });

    return {
      status: writeStatus(applied, rejected),
      appliedActions: applied,
      rejected,
      ...(opts.includeBoard === false
        ? {}
        : {
            board: maskNodesForViewer(server.getBoard(boardId) ?? [], user.id),
          }),
    };
  });
}

// the board as the user may see it: hidden notes of others are blank
export async function readBoardAsMcpUser(
  server: Server,
  user: McpUser,
  boardId: string,
) {
  const haveAccess = await db.board.haveAccess(boardId, user.id);

  if (!haveAccess) {
    throw new Error('Unable to read board with this API token');
  }

  const nodes = (await server.readBoard(boardId)) ?? [];
  const settings = nodes.find(isSettings)?.content;
  const isAdmin = (await db.board.getBoardAdmins(boardId)).includes(user.id);
  const visible = maskNodesForViewer(nodes, user.id);

  return {
    boardId,
    viewer: {
      userId: user.id,
      isAdmin,
      readOnly: !!settings?.readOnly,
      notesHidden: isNotesHidden(settings),
    },
    contentBounds: boundsOfNodes(visible),
    nodes: visible,
  };
}

// advisory layout checks on the board as the user sees it
export async function lintBoardAsMcpUser(
  server: Server,
  user: McpUser,
  boardId: string,
  nodeIds?: string[],
) {
  const { nodes, contentBounds } = await readBoardAsMcpUser(
    server,
    user,
    boardId,
  );
  const ids = new Set(nodes.map((node) => node.id));
  const missingNodeIds = (nodeIds ?? []).filter((id) => !ids.has(id));
  // no isAdmin: layer_admin_only is about writes, and every layer-1 node
  // already on the board was put there by an admin
  const issues = lintNodes(nodes, { scopeIds: nodeIds });

  return {
    issues,
    counts: {
      error: issues.filter((it) => it.level === 'error').length,
      warning: issues.filter((it) => it.level === 'warning').length,
    },
    contentBounds,
    ...(missingNodeIds.length ? { missingNodeIds } : {}),
  };
}

const PREVIEW_PADDING = 80;
// renders are queued globally too (preview-renderer.ts)
const MAX_PREVIEWS_PER_USER = 2;
const previewsInFlight = new Map<string, number>();

export type PreviewRegion = 'content' | Rect | { nodeIds: string[] };

export interface PreviewLegend {
  // board coordinates the image shows
  region: Rect | null;
  // image pixels per board unit
  scale?: number;
  image?: { width: number; height: number };
  nodeCount: number;
  skippedAssets: { url: string; reason: string }[];
  // emoji drawn as placeholder shapes (the server has no emoji font)
  emojiPlaceholders: number;
  emojiNote?: string;
  missingNodeIds?: string[];
  message?: string;
}

const padRect = (rect: Rect, pad: number): Rect => ({
  x: rect.x - pad,
  y: rect.y - pad,
  width: rect.width + 2 * pad,
  height: rect.height + 2 * pad,
});

/**
 * A PNG of the board as the user sees it (hidden notes of others stay
 * blank). With nothing to draw there is no png and the legend says why.
 */
export async function previewBoardAsMcpUser(
  server: Server,
  user: McpUser,
  boardId: string,
  opts: { region?: PreviewRegion; width?: number; fetch?: typeof fetch } = {},
): Promise<{ png?: Buffer; legend: PreviewLegend }> {
  const { nodes, contentBounds } = await readBoardAsMcpUser(
    server,
    user,
    boardId,
  );
  const requested = opts.region ?? 'content';
  let region: Rect | null;
  let missingNodeIds: string[] = [];

  if (requested === 'content') {
    region = contentBounds && padRect(contentBounds, PREVIEW_PADDING);
  } else if ('nodeIds' in requested) {
    const wanted = new Set(requested.nodeIds);
    const byId = nodesById(nodes);
    // the whole board's byId, so attached arrows are bounded where they render
    const bounds = unionRects(
      nodes
        .filter((node) => wanted.has(node.id))
        .map((node) => nodeBounds(node, byId))
        .filter((it): it is Rect => it !== null),
    );

    region = bounds && padRect(bounds, PREVIEW_PADDING);
    missingNodeIds = [...wanted].filter((id) => !byId.has(id));
  } else {
    region = requested;
  }

  const legend = {
    region,
    nodeCount: 0,
    skippedAssets: [],
    emojiPlaceholders: 0,
    ...(missingNodeIds.length ? { missingNodeIds } : {}),
  };

  if (!region) {
    return {
      legend: {
        ...legend,
        message:
          requested === 'content'
            ? 'The board is empty; there is nothing to preview'
            : 'None of nodeIds is a positioned top-level node on the board',
      },
    };
  }

  if (!previewImageSize(region, opts.width ?? 1200)) {
    return {
      legend: {
        ...legend,
        message: `The region is too thin to draw within 1600x4800 pixels (${Math.round(region.width)}x${Math.round(region.height)} board units); preview a smaller rectangle or nodeIds`,
      },
    };
  }

  const nodeCount = previewNodes(nodes, region).length;

  if (!nodeCount) {
    return {
      legend: { ...legend, message: 'Nothing on the board is in the region' },
    };
  }

  const inFlight = previewsInFlight.get(user.id) ?? 0;

  if (inFlight >= MAX_PREVIEWS_PER_USER) {
    throw new Error(
      'Another preview of this user is still rendering; wait for it first',
    );
  }

  previewsInFlight.set(user.id, inFlight + 1);

  let rendered: Awaited<ReturnType<typeof renderBoardPreview>>;

  try {
    rendered = await renderBoardPreview(nodes, region, opts.width ?? 1200, {
      viewerId: user.id,
      fetch: opts.fetch,
    });
  } finally {
    const left = (previewsInFlight.get(user.id) ?? 1) - 1;

    if (left > 0) {
      previewsInFlight.set(user.id, left);
    } else {
      previewsInFlight.delete(user.id);
    }
  }

  const { png, skipped, scale, emojiPlaceholders } = rendered;

  return {
    png,
    legend: {
      ...legend,
      scale,
      // from the PNG header
      image: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
      nodeCount,
      skippedAssets: skipped,
      emojiPlaceholders,
      ...(emojiPlaceholders ? { emojiNote: EMOJI_PLACEHOLDER_NOTE } : {}),
    },
  };
}

const COMPACT_TEXT_LENGTH = 120;

const plainText = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COMPACT_TEXT_LENGTH);

export interface CompactNode {
  id: string;
  type: string;
  layer?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parent?: string;
  text?: string;
}

// one line per node for layout work: geometry plus a text excerpt
export function compactBoardNodes(nodes: TuNode[]): CompactNode[] {
  const compact = (node: TuNode, parent?: string): CompactNode => {
    const content = (node.content ?? {}) as {
      layer?: unknown;
      position?: { x?: unknown; y?: unknown };
      width?: unknown;
      height?: unknown;
      text?: unknown;
    };
    const num = (value: unknown) =>
      typeof value === 'number' ? value : undefined;
    const text =
      typeof content.text === 'string' ? plainText(content.text) : '';
    const fields: CompactNode = {
      id: node.id,
      type: node.type,
      layer: num(content.layer),
      x: num(content.position?.x),
      y: num(content.position?.y),
      width: num(content.width),
      height: num(content.height),
      parent,
      text: text || undefined,
    };

    return Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as CompactNode;
  };

  return nodes.flatMap((node) => [
    compact(node),
    ...(node.children ?? []).map((child) => compact(child, node.id)),
  ]);
}

export function createTapizMcpServer(boardServer: Server, user: McpUser) {
  const server = new McpServer(
    {
      name: 'tapiz',
      version: '0.1.0',
    },
    {
      instructions: TAPIZ_MCP_INSTRUCTIONS,
    },
  );
  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description:
        'Read the current Tapiz board nodes for a board the API token can access. Call this before editing so you preserve existing content, runtime nodes, positions, layers, and parent/child relationships. The result includes viewer { userId, isAdmin, readOnly, notesHidden }: when isAdmin is false, use layer 0 only; when readOnly is true, changes from users who are not admins are rejected. contentBounds { x, y, width, height } is the box around every positioned node (null for an empty board); place new content outside it. format "compact" returns one entry per node (children follow their parent) with id, type, layer, x, y, width, height, parent and a plain-text excerpt of up to 120 characters, which is enough for placing new content; use "full" before patching content.',
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        format: z
          .enum(['full', 'compact'])
          .default('full')
          .describe(
            'full: complete node content; compact: geometry and a text excerpt per node',
          ),
      }),
      annotations: {
        title: 'Get board',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ boardId, format }) => {
      const board = await readBoardAsMcpUser(boardServer, user, boardId);

      return textResult(
        format === 'compact'
          ? { ...board, nodes: compactBoardNodes(board.nodes) }
          : board,
      );
    }),
  );

  server.registerTool(
    'add_node',
    {
      title: 'Add node',
      description: [
        'Add one Tapiz board node as the authenticated user. The node content must match the Tapiz schema for its type. Returns status, appliedActions and rejected, as apply_board_actions does.',
        BOARD_NODE_TYPE_GUIDANCE,
        BOARD_RICH_TEXT_GUIDANCE,
      ].join(' '),
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        node: nodeSchema.describe('Node to add'),
        parent: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Optional parent node ID'),
        position: z
          .number()
          .int()
          .optional()
          .describe('Optional insertion index within the parent'),
      }),
      annotations: {
        title: 'Add node',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ boardId, node, parent, position }) => {
      const result = await applyBoardActionsAsMcpUser(
        boardServer,
        user,
        boardId,
        [
          {
            op: 'add',
            data: node as TuNode,
            parent,
            position,
          },
        ],
      );

      return textResult(result);
    }),
  );

  server.registerTool(
    'patch_node',
    {
      title: 'Patch node',
      description: [
        'Patch one existing Tapiz board node as the authenticated user. Only include changed content fields and preserve fields you are not intentionally changing. Returns status, appliedActions and rejected, as apply_board_actions does.',
        BOARD_RICH_TEXT_GUIDANCE,
      ].join(' '),
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        id: z.string().min(1).max(255).describe('Node ID to patch'),
        type: z.string().min(1).max(255).describe('Node type'),
        content: z
          .record(z.string(), z.unknown())
          .describe('Partial node content to merge into the node'),
        parent: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Optional parent node ID'),
        position: z
          .number()
          .int()
          .optional()
          .describe('Optional insertion index within the parent'),
      }),
      annotations: {
        title: 'Patch node',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(
      async ({ boardId, id, type, content, parent, position }) => {
        const result = await applyBoardActionsAsMcpUser(
          boardServer,
          user,
          boardId,
          [
            {
              op: 'patch',
              data: {
                id,
                type,
                content,
              },
              parent,
              position,
            },
          ],
        );

        return textResult(result);
      },
    ),
  );

  server.registerTool(
    'remove_node',
    {
      title: 'Remove node',
      description:
        'Remove one existing Tapiz board node as the authenticated user. Preserve user, settings, timer, poll, estimation, and other workflow/runtime nodes unless the user explicitly asked to remove them. Returns status, appliedActions and rejected, as apply_board_actions does.',
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        id: z.string().min(1).max(255).describe('Node ID to remove'),
        type: z.string().min(1).max(255).describe('Node type'),
        parent: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Optional parent node ID'),
      }),
      annotations: {
        title: 'Remove node',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ boardId, id, type, parent }) => {
      const result = await applyBoardActionsAsMcpUser(
        boardServer,
        user,
        boardId,
        [
          {
            op: 'remove',
            data: {
              id,
              type,
            },
            parent,
          },
        ],
      );

      return textResult(result);
    }),
  );

  server.registerTool(
    'apply_board_actions',
    {
      title: 'Apply board actions',
      description: [
        'Apply multiple Tapiz board add, patch, and remove actions as one authenticated realtime edit batch. Returns status (applied or rejected; partial is reserved and not produced today), appliedActions, rejected (index, op, id, type, code, message, hint, issues, dependsOn) and, unless includeBoard is false, the board.',
        BOARD_BATCH_EDIT_GUIDANCE,
        BOARD_NODE_TYPE_GUIDANCE,
        BOARD_RICH_TEXT_GUIDANCE,
      ].join(' '),
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        actions: z
          .array(actionSchema)
          .min(1)
          .max(100)
          .describe('Tapiz StateActions to process in order'),
        includeBoard: z
          .boolean()
          .default(true)
          .describe(
            'Return the whole board after the batch; pass false to keep the result small',
          ),
      }),
      annotations: {
        title: 'Apply board actions',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ boardId, actions, includeBoard }) => {
      const result = await applyBoardActionsAsMcpUser(
        boardServer,
        user,
        boardId,
        actions as StateActions[],
        { includeBoard },
      );

      return textResult(result);
    }),
  );

  server.registerTool(
    'create_layout',
    {
      title: 'Create layout',
      description: CREATE_LAYOUT_DESCRIPTION,
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        layout: layoutSpecSchema.describe(
          'The layout: kind (columns, grid, quadrants or radial), optional title and description, cells with a title, optional subtitle, style (shape, backgroundColor, borderColor, borderWidth, frameless), seed notes and capacity, and optional decorations (https://cocomaterial.com art with an anchor and a size)',
        ),
        origin: insertOriginSchema,
        placement: insertPlacementSchema,
        layer: insertLayerSchema,
        dryRun: insertDryRunSchema,
      }),
      annotations: {
        title: 'Create layout',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(
      async ({ boardId, layout, origin, placement, layer, dryRun }) => {
        const noteColor =
          layout.noteColor ??
          withDefaultUserSettings((await db.user.getUser(user.id))?.settings)
            .noteDefaults.backgroundColor;
        const expanded = expandLayout(layout, { noteColor });
        const result = await insertTemplateAsMcpUser(
          boardServer,
          user,
          boardId,
          expanded.template,
          { origin, placement, layer, dryRun },
        );
        const onBoard = (point: { x: number; y: number }) => ({
          x: result.origin.x + point.x,
          y: result.origin.y + point.y,
        });

        return textResult({
          ...result,
          cells: expanded.cells.map((cell) => ({
            ref: cell.ref,
            title: cell.title,
            panelId: result.refs[cell.ref],
            bounds: { ...cell.bounds, ...onBoard(cell.bounds) },
            noteIds: cell.noteRefs
              .map((ref) => result.refs[ref])
              .filter((id): id is string => !!id),
            freeSlots: cell.freeSlots.map(onBoard),
          })),
        });
      },
    ),
  );

  server.registerTool(
    'lint_board',
    {
      title: 'Lint board',
      description:
        'Check the layout of a board, or of the nodes in nodeIds, for common problems: text overflowing its node, raw h1-h3 headings, note text too long for the note, overlapping notes, notes over a panel header, panel color recolouring notes, dangling arrow attachments and non-positive sizes. Advisory only: it changes nothing. Returns { issues: [{ level, code, nodeIds, message, hint }], counts: { error, warning }, contentBounds } and missingNodeIds for nodeIds that are not on the board. Text sizes are estimates; confirm in the browser.',
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        nodeIds: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Only report issues that involve these nodes; omit it to lint the whole board',
          ),
      }),
      annotations: {
        title: 'Lint board',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ boardId, nodeIds }) => {
      return textResult(
        await lintBoardAsMcpUser(boardServer, user, boardId, nodeIds),
      );
    }),
  );

  server.registerTool(
    'preview_board',
    {
      title: 'Preview board',
      description: PREVIEW_BOARD_DESCRIPTION,
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID'),
        region: previewRegionSchema,
        width: z
          .number()
          .int()
          .min(400)
          .max(1600)
          .default(1200)
          .describe('Image width in pixels'),
      }),
      annotations: {
        title: 'Preview board',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // it fetches the Cocomaterial art on the board
        openWorldHint: true,
      },
    },
    hideQueryDetails(async ({ boardId, region, width }) => {
      const { png, legend } = await previewBoardAsMcpUser(
        boardServer,
        user,
        boardId,
        { region, width },
      );

      if (!png) {
        return textResult(legend);
      }

      return {
        content: [
          {
            type: 'image' as const,
            data: png.toString('base64'),
            mimeType: 'image/png',
          },
          {
            type: 'text' as const,
            text: JSON.stringify(legend, null, 2),
          },
        ],
      };
    }),
  );

  server.registerTool(
    'list_templates',
    {
      title: 'List templates',
      description:
        'List the templates the API token user can read: first the built-in templates (scope { kind: builtin }, id builtin:<slug>, read-only, createdBy/createdAt/updatedAt null), then their personal templates and the templates of their teams, newest first. Returns { templates: [{ id, name, description, scope: { kind: builtin } | { kind: personal } | { kind: team, teamId, teamName }, nodeCount, width, height, createdBy, createdAt, updatedAt, canEdit }] }. canEdit means the user may delete it. To see what a template holds, call get_template with includeData: true, or insert it with dryRun and look at it with preview_board. Place one with insert_template.',
      inputSchema: z.object({}),
      annotations: {
        title: 'List templates',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async () => {
      const [builtins, saved] = await Promise.all([
        listBuiltinTemplates(),
        // no thumbnail outlines: they would only fill the context
        listTemplateSummaries(user.id),
      ]);

      return textResult({ templates: [...builtins, ...saved] });
    }),
  );

  server.registerTool(
    'get_template',
    {
      title: 'Get template',
      description:
        'Read one built-in (builtin:<slug>) or saved template the API token user can read. Returns { template } with the fields of list_templates; with includeData, template.data is { version, size, nodes: [{ ref, type, content }] }, positions relative to the template top-left. A template the user cannot read is reported as not found.',
      inputSchema: z.object({
        templateId: templateIdSchema,
        includeData: z
          .boolean()
          .default(false)
          .describe('Include the template nodes'),
      }),
      annotations: {
        title: 'Get template',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ templateId, includeData }) => {
      const { data, ...template } = isBuiltinTemplateId(templateId)
        ? await loadBuiltinTemplate(templateId).then((it) => ({
            ...it.template,
            data: it.data,
          }))
        : await getTemplateWithData(templateId, user.id);

      return textResult({
        template: includeData ? { ...template, data } : template,
      });
    }),
  );

  server.registerTool(
    'save_board_as_template',
    {
      title: 'Save board as template',
      description: SAVE_TEMPLATE_DESCRIPTION,
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID to save from'),
        name: z.string().trim().min(1).max(256).describe('Template name'),
        description: z
          .string()
          .max(2000)
          .optional()
          .describe('Optional template description'),
        nodeIds: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Nodes to save, e.g. the refs values from create_layout; default: the whole board',
          ),
        includeContained: z
          .boolean()
          .default(true)
          .describe(
            'Also save the nodes inside the selected panels and groups',
          ),
        scope: z
          .enum(['personal', 'team'])
          .default('personal')
          .describe('personal: only the user; team: every member of the team'),
        teamId: z
          .uuid()
          .optional()
          .describe(
            'Team for scope "team"; default: the board\'s team. Not allowed with scope "personal"',
          ),
      }),
      annotations: {
        title: 'Save board as template',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async (input) => {
      return textResult(
        await saveTemplateFromBoard(boardServer, {
          ...input,
          userId: user.id,
        }),
      );
    }),
  );

  server.registerTool(
    'insert_template',
    {
      title: 'Insert template',
      description: INSERT_TEMPLATE_DESCRIPTION,
      inputSchema: z.object({
        boardId: boardIdSchema.describe('Tapiz board UUID to insert into'),
        templateId: templateIdSchema,
        origin: insertOriginSchema,
        placement: insertPlacementSchema,
        layer: insertLayerSchema,
        dryRun: insertDryRunSchema,
      }),
      annotations: {
        title: 'Insert template',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(
      async ({ boardId, templateId, origin, placement, layer, dryRun }) => {
        const builtin = isBuiltinTemplateId(templateId);
        const { data } = builtin
          ? await loadBuiltinTemplate(templateId)
          : await requireTemplate(templateId, user.id, 'read');
        const result = await insertTemplateAsMcpUser(
          boardServer,
          user,
          boardId,
          data,
          { origin, placement, layer, dryRun },
        );

        return textResult(
          builtin
            ? {
                ...result,
                // built-in content is kept as it ships, headings included
                lint: result.lint.filter((it) => it.code !== 'raw_heading'),
              }
            : result,
        );
      },
    ),
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete template',
      description:
        'Delete a saved template for good; built-in templates cannot be deleted. Personal templates can be deleted by their owner, team templates by team admins and by the member who saved them. Boards the template was inserted into keep their copies. Returns { success: true }.',
      inputSchema: z.object({ templateId: templateIdSchema }),
      annotations: {
        title: 'Delete template',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async ({ templateId }) => {
      await deleteTemplateAsUser(templateId, user.id);

      return textResult({ success: true });
    }),
  );

  server.registerTool(
    'get_user_settings',
    {
      title: 'Get user settings',
      description:
        'Read the authenticated Tapiz user settings, including default note styling useful for creating note nodes with the current user as ownerId.',
      inputSchema: z.object({}),
      annotations: {
        title: 'Get user settings',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    hideQueryDetails(async () => {
      const dbUser = await db.user.getUser(user.id);

      return textResult({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        settings: withDefaultUserSettings(dbUser?.settings),
      });
    }),
  );

  server.registerTool(
    'list_cocomaterial_tags',
    {
      title: 'List Cocomaterial tags',
      description:
        'Find Cocomaterial tag slugs for search_cocomaterial_vectors. Pass a query such as "space", "sea" or "party" (a case-insensitive substring of the tag slug or name), then call search_cocomaterial_vectors with the slugs you pick. Returns { total (tags matching the query), returned, tags (slugs only, sorted), truncated (true when total > returned; narrow the query or raise limit) }. Without a query it lists every tag up to limit.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe(
            'Case-insensitive substring of the tag slug or name, e.g. "space" or "sea"',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(200)
          .describe('Maximum number of slugs to return'),
      }),
      annotations: {
        title: 'List Cocomaterial tags',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    hideQueryDetails(async ({ query, limit }) => {
      return textResult(
        filterCocomaterialTags(await fetchCocomaterialTags(), query, limit),
      );
    }),
  );

  server.registerTool(
    'search_cocomaterial_vectors',
    {
      title: 'Search Cocomaterial vectors',
      description:
        'Search Cocomaterial assets by tag slugs. When tags are unknown, call list_cocomaterial_tags with a query such as "space" or "sea" first. Each result has aspectRatio (width / height of the art, null when unknown): give nodes and layout decorations a width and height in that ratio, since the art is letterboxed inside its box.',
      inputSchema: z.object({
        page: z.number().int().min(1).default(1).describe('Results page'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(20)
          .describe('Number of assets to return'),
        tags: cocomaterialTagsSchema
          .default([])
          .describe('Cocomaterial tag slugs to filter by'),
      }),
      annotations: {
        title: 'Search Cocomaterial vectors',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    hideQueryDetails(async ({ page, pageSize, tags }) => {
      const params = new URLSearchParams({
        page: page.toString(),
        page_size: pageSize.toString(),
      });

      if (tags.length) {
        params.set('tags', tags.join(','));
      }

      const result = await fetchCocomaterial<CocomaterialApiListVectors>(
        `/vectors?${params.toString()}`,
      );

      return textResult({
        count: result.count,
        next: result.next,
        previous: result.previous,
        results: result.results.map(compactCocomaterialVector),
      });
    }),
  );

  server.registerTool(
    'add_cocomaterial_asset',
    {
      title: 'Add Cocomaterial asset',
      description:
        'Add a selected Cocomaterial asset to a Tapiz board as a vector or image node. Use visual assets sparingly for decoration or context; keep editable meeting content in notes, panels, groups, or text nodes. Returns status, appliedActions and rejected, as apply_board_actions does.',
      inputSchema: cocomaterialNodeSchema,
      annotations: {
        title: 'Add Cocomaterial asset',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    hideQueryDetails(async ({ boardId, ...nodeInput }) => {
      const result = await applyBoardActionsAsMcpUser(
        boardServer,
        user,
        boardId,
        [createCocomaterialNodeAction(nodeInput)],
      );

      return textResult(result);
    }),
  );

  return server;
}

async function handleMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  getBoardServer: () => Server,
) {
  if (!isAllowedOrigin(request.headers.origin)) {
    return reply.code(403).send({ error: 'Origin not allowed' });
  }

  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  const user = await authenticateApiToken(authorization);

  if (!user) {
    return reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer realm="tapiz-mcp"')
      .send({ error: 'Unauthorized' });
  }

  const mcpServer = createTapizMcpServer(getBoardServer(), user);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  reply.raw.on('close', () => {
    void transport.close();
  });

  await mcpServer.connect(transport);
  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw, request.body);
}

export function registerTapizMcp(
  fastify: FastifyInstance,
  getBoardServer: () => Server,
) {
  fastify.get('/api/mcp/health', async () => {
    return { status: 'ok' };
  });

  fastify.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/mcp',
    handler: (request, reply) => {
      return handleMcpRequest(request, reply, getBoardServer);
    },
  });
}
