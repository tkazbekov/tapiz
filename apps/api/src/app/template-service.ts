import { z } from 'zod';
import {
  TEMPLATE_LIMITS,
  findBuiltinTemplate,
  BUILTIN_TEMPLATES,
  isNote,
  isNoteMaskedFor,
  isUserNode,
  lintNodes,
  nodeBounds,
  nodesById,
  parseBoardTemplate,
  rectContains,
  templateFromNodes,
  type BoardTemplateData,
  type DroppedNode,
  type LintIssue,
  type TemplateIssue,
  type TemplatePreviewRect,
  type TuNode,
} from '@tapiz/board-commons';
import { sanitizeNodeRichText } from '@tapiz/board-commons/rich-text/rich-text-sanitizer.js';
import db from './db/index.js';
import type { TemplateRow, TemplateSummaryRow } from './db/template-db.js';
import type { TeamRole } from './schema.js';
import type { Server } from './server.js';
import { sanitizeRichText } from './rich-text.js';

/*
 * Saved templates, shared by tRPC and MCP. Denials are NOT_FOUND or
 * FORBIDDEN, never UNAUTHORIZED: the web app logs the user out on a 401.
 */

export const TEMPLATE_QUOTAS = { account: 200, team: 500 } as const;

export type TemplateErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST';

export type TemplateErrorReason =
  | 'template_not_found'
  | 'board_not_found'
  | 'node_not_found'
  | 'template_read_only'
  | 'team_forbidden'
  | 'team_required'
  | 'scope_mismatch'
  | 'corrupt_template'
  | 'empty_template'
  | 'invalid_template'
  | 'template_too_large'
  | 'template_limit_reached';

export class TemplateError extends Error {
  constructor(
    readonly code: TemplateErrorCode,
    readonly reason: TemplateErrorReason,
    message: string,
    readonly issues?: TemplateIssue[],
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

export type TemplateAccess = 'none' | 'read' | 'write';

export type TemplateScope =
  | { kind: 'personal' }
  | { kind: 'team'; teamId: string; teamName: string | null };

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  scope: TemplateScope;
  nodeCount: number;
  width: number;
  height: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

// a listed template, with an outline for thumbnails (null: unreadable data)
export type ListedTemplate = TemplateSummary & {
  preview: TemplatePreviewRect[] | null;
};

export type TemplateWithData = TemplateSummary & { data: BoardTemplateData };

/**
 * A template that ships with Tapiz (BUILTIN_TEMPLATES): everyone can read
 * it, nobody can change or delete it, and it never touches the database.
 */
export interface BuiltinTemplateSummary {
  id: `builtin:${string}`;
  name: string;
  description: string;
  scope: { kind: 'builtin' };
  nodeCount: number;
  width: number;
  height: number;
  createdBy: null;
  createdAt: null;
  updatedAt: null;
  canEdit: false;
}

// a template read for a user: `data` has been parsed
export type LoadedTemplate = TemplateRow & {
  data: BoardTemplateData;
  access: 'read' | 'write';
};

type AccessFields = Pick<TemplateRow, 'accountId' | 'teamId' | 'createdBy'>;

const uuid = z.uuid();
const isUuid = (id: string) => uuid.safeParse(id).success;

const templateNotFound = () =>
  new TemplateError('NOT_FOUND', 'template_not_found', 'Template not found');

const boardNotFound = () =>
  new TemplateError('NOT_FOUND', 'board_not_found', 'Board not found');

// personal: only the owner. team: members read, team admins and the creator
// write. A creator who left the team has no access.
function accessFor(
  template: AccessFields,
  userId: string,
  role: TeamRole | null | undefined,
): TemplateAccess {
  if (template.accountId) {
    return template.accountId === userId ? 'write' : 'none';
  }

  if (!template.teamId || !role) {
    return 'none';
  }

  return role === 'admin' || template.createdBy === userId ? 'write' : 'read';
}

export async function templateAccess(
  template: AccessFields,
  userId: string,
): Promise<TemplateAccess> {
  if (template.accountId || !template.teamId) {
    return accessFor(template, userId, null);
  }

  const member = await db.team.getUserTeam(template.teamId, userId);

  return accessFor(template, userId, member?.role);
}

export function toSummary(
  row: Omit<TemplateRow, 'data'>,
  access: 'read' | 'write',
): TemplateSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.teamId
      ? { kind: 'team', teamId: row.teamId, teamName: row.teamName }
      : { kind: 'personal' },
    nodeCount: row.nodeCount,
    width: row.width,
    height: row.height,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canEdit: access === 'write',
  };
}

async function listReadableTemplates(
  userId: string,
  options: { teamId?: string; withPreview: boolean },
) {
  if (options.teamId && !isUuid(options.teamId)) {
    return [];
  }

  const rows = await db.template.listTemplatesForUser(userId, options);

  return rows.flatMap((row: TemplateSummaryRow) => {
    const access = accessFor(row, userId, row.memberRole);

    return access === 'none' ? [] : [{ row, access }];
  });
}

/**
 * The templates the user can read, each with the preview stored when it was
 * saved (templates never change). Quotas allow 200 personal templates plus
 * 500 per team, so only the small stored outline is read, never `data`.
 */
export async function listTemplates(
  userId: string,
  options: { teamId?: string } = {},
): Promise<ListedTemplate[]> {
  const readable = await listReadableTemplates(userId, {
    ...options,
    withPreview: true,
  });

  return readable.map(({ row, access }) => ({
    ...toSummary(row, access),
    preview: row.preview ?? null,
  }));
}

/** listTemplates without the previews, for callers that draw nothing. */
export async function listTemplateSummaries(
  userId: string,
  options: { teamId?: string } = {},
): Promise<TemplateSummary[]> {
  const readable = await listReadableTemplates(userId, {
    ...options,
    withPreview: false,
  });

  return readable.map(({ row, access }) => toSummary(row, access));
}

export const isBuiltinTemplateId = (id: string) => id.startsWith('builtin:');

/** A built-in template and its data; unknown ids are not found. */
export async function loadBuiltinTemplate(id: string): Promise<{
  template: BuiltinTemplateSummary;
  data: BoardTemplateData;
}> {
  const builtin = findBuiltinTemplate(id);

  if (!builtin) {
    throw templateNotFound();
  }

  const data = await builtin.load();

  return {
    template: {
      id: builtin.id,
      name: builtin.name,
      description: builtin.description,
      scope: { kind: 'builtin' },
      nodeCount: data.nodes.length,
      width: Math.ceil(data.size.width),
      height: Math.ceil(data.size.height),
      createdBy: null,
      createdAt: null,
      updatedAt: null,
      canEdit: false,
    },
    data,
  };
}

export async function listBuiltinTemplates(): Promise<
  BuiltinTemplateSummary[]
> {
  return Promise.all(
    BUILTIN_TEMPLATES.map(
      async ({ id }) => (await loadBuiltinTemplate(id)).template,
    ),
  );
}

/**
 * The template row, if the user may `need` it. The data is not parsed, so a
 * template that no longer parses can still be deleted.
 */
export async function requireTemplateAccess(
  templateId: string,
  userId: string,
  need: 'read' | 'write',
): Promise<TemplateRow & { access: 'read' | 'write' }> {
  const row = isUuid(templateId)
    ? await db.template.getTemplate(templateId)
    : undefined;

  if (!row) {
    throw templateNotFound();
  }

  const access = await templateAccess(row, userId);

  if (access === 'none') {
    throw templateNotFound();
  }

  if (need === 'write' && access !== 'write') {
    throw new TemplateError(
      'FORBIDDEN',
      'template_read_only',
      'Only the team admins and the creator can change this template',
    );
  }

  return { ...row, access };
}

/**
 * Loads a template the user may `need`, with its data parsed (and upgraded)
 * on every read. Access is checked before parsing, so outsiders learn nothing
 * about the data.
 */
export async function requireTemplate(
  templateId: string,
  userId: string,
  need: 'read' | 'write',
): Promise<LoadedTemplate> {
  const row = await requireTemplateAccess(templateId, userId, need);
  const parsed = parseBoardTemplate(row.data);

  if (!parsed.ok) {
    throw new TemplateError(
      'BAD_REQUEST',
      'corrupt_template',
      'The stored template data is not valid',
      parsed.issues,
    );
  }

  return { ...row, data: parsed.data };
}

export async function getTemplateWithData(
  templateId: string,
  userId: string,
): Promise<TemplateWithData> {
  const template = await requireTemplate(templateId, userId, 'read');

  return { ...toSummary(template, template.access), data: template.data };
}

// no parsing: a template whose data no longer parses can still be removed
export async function deleteTemplateAsUser(templateId: string, userId: string) {
  if (isBuiltinTemplateId(templateId)) {
    throw findBuiltinTemplate(templateId)
      ? new TemplateError(
          'FORBIDDEN',
          'template_read_only',
          'Built-in templates cannot be deleted',
        )
      : templateNotFound();
  }

  await requireTemplateAccess(templateId, userId, 'write');
  await db.template.deleteTemplate(templateId);
}

export type ResolvedScope =
  { accountId: string; teamId: null } | { accountId: null; teamId: string };

/**
 * A team template goes to `teamId`, or else to the board's team. Whichever
 * it is, the user must be a member: board access alone (a board admin outside
 * the team, a public board) is not enough.
 */
export async function resolveScope(
  userId: string,
  input: {
    scope: 'personal' | 'team';
    teamId?: string | null;
    boardTeamId?: string | null;
  },
): Promise<ResolvedScope> {
  if (input.scope === 'personal') {
    if (input.teamId) {
      throw new TemplateError(
        'BAD_REQUEST',
        'scope_mismatch',
        'teamId only applies to scope "team"',
      );
    }

    return { accountId: userId, teamId: null };
  }

  const teamId = input.teamId ?? input.boardTeamId;

  if (!teamId) {
    throw new TemplateError(
      'BAD_REQUEST',
      'team_required',
      'The board has no team; pass teamId or use scope "personal"',
    );
  }

  const member = isUuid(teamId)
    ? await db.team.getUserTeam(teamId, userId)
    : undefined;

  if (!member) {
    throw new TemplateError(
      'FORBIDDEN',
      'team_forbidden',
      'Only members of the team can save team templates',
    );
  }

  return { accountId: null, teamId };
}

const quotaOf = (scope: ResolvedScope) =>
  scope.accountId === null ? TEMPLATE_QUOTAS.team : TEMPLATE_QUOTAS.account;

const limitReached = (scope: ResolvedScope, count: number) =>
  new TemplateError(
    'BAD_REQUEST',
    'template_limit_reached',
    `This ${scope.teamId ? 'team' : 'account'} already has ${count} templates, the limit is ${quotaOf(scope)}`,
  );

// fails early, before the board is read; the insert checks it again
async function checkQuota(scope: ResolvedScope) {
  const count = await db.template.countTemplates(
    scope.accountId === null
      ? { teamId: scope.teamId }
      : { accountId: scope.accountId },
  );

  if (count >= quotaOf(scope)) {
    throw limitReached(scope, count);
  }
}

const CONTAINER_TYPES = new Set(['panel', 'group']);

/**
 * The given nodes (every node when none are given), plus, with
 * `includeContained`, the nodes that lie inside a selected panel or group.
 */
export function selectTemplateNodes(
  nodes: TuNode[],
  nodeIds: string[] | undefined,
  includeContained: boolean,
): TuNode[] {
  if (!nodeIds) {
    return nodes;
  }

  const wanted = new Set(nodeIds);
  const selected = nodes.filter((node) => wanted.has(node.id));
  const found = new Set(selected.map((node) => node.id));
  const missing = [...wanted].filter((id) => !found.has(id));

  if (missing.length) {
    throw new TemplateError(
      'BAD_REQUEST',
      'node_not_found',
      `Nodes not on the board: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`,
    );
  }

  if (!includeContained) {
    return selected;
  }

  const byId = nodesById(nodes);
  const containers = selected
    .filter((node) => CONTAINER_TYPES.has(node.type))
    .map((node) => nodeBounds(node, byId))
    .filter((bounds) => !!bounds);

  if (!containers.length) {
    return selected;
  }

  return nodes.filter((node) => {
    if (found.has(node.id)) {
      return true;
    }

    // attached arrows are bounded where they render
    const bounds = nodeBounds(node, byId);

    return (
      !!bounds &&
      containers.some((container) => rectContains(container, bounds))
    );
  });
}

/**
 * Notes the saver may not read: masked while notes are hidden, or another
 * user's private text. Like the board, a note's own textHidden wins over its
 * owner's visible setting.
 */
export function isNoteUnreadableFor(
  node: TuNode,
  nodes: TuNode[],
  userId: string,
): boolean {
  if (isNoteMaskedFor(node, nodes, userId)) {
    return true;
  }

  if (!isNote(node) || node.content.ownerId === userId) {
    return false;
  }

  const { textHidden, ownerId } = node.content;

  if (textHidden !== undefined && textHidden !== null) {
    return textHidden === true;
  }

  const owner = nodes.filter(isUserNode).find((it) => it.id === ownerId);

  return owner?.content.visible === false;
}

export interface SaveTemplateInput {
  userId: string;
  boardId: string;
  nodeIds?: string[];
  includeContained?: boolean;
  name: string;
  description?: string | null;
  scope: 'personal' | 'team';
  teamId?: string | null;
}

export interface SaveTemplateResult {
  template: TemplateSummary;
  dropped: DroppedNode[];
  detachedArrows: string[];
  lint: LintIssue[];
}

export async function saveTemplateFromBoard(
  server: Server | null | undefined,
  input: SaveTemplateInput,
): Promise<SaveTemplateResult> {
  const { userId, boardId } = input;

  if (!isUuid(boardId) || !(await db.board.haveAccess(boardId, userId))) {
    throw boardNotFound();
  }

  const board = await db.board.getBoardBasic(boardId);

  if (!board) {
    throw boardNotFound();
  }

  const scope = await resolveScope(userId, {
    scope: input.scope,
    teamId: input.teamId,
    boardTeamId: board.teamId,
  });

  await checkQuota(scope);

  // the live board is newer than the stored one
  const nodes =
    (server
      ? await server.readBoard(boardId)
      : (await db.board.getBoard(boardId))?.board) ?? [];
  const selection = selectTemplateNodes(
    nodes,
    input.nodeIds,
    input.includeContained ?? true,
  );

  const { data, dropped, detachedArrows } = templateFromNodes(selection, {
    boardNodes: nodes,
    isMasked: (node) => isNoteUnreadableFor(node, nodes, userId),
  });

  const sanitized: BoardTemplateData = {
    ...data,
    nodes: data.nodes.map((node) => ({
      ...node,
      content: sanitizeNodeRichText(
        { type: node.type, content: node.content },
        sanitizeRichText,
      ).content as typeof node.content,
    })),
  };

  if (!sanitized.nodes.length) {
    throw new TemplateError(
      'BAD_REQUEST',
      'empty_template',
      dropped.length
        ? `Nothing to save: all ${dropped.length} selected nodes were dropped`
        : 'Nothing to save',
    );
  }

  const bytes = Buffer.byteLength(JSON.stringify(sanitized));

  if (
    sanitized.nodes.length > TEMPLATE_LIMITS.maxNodes ||
    bytes > TEMPLATE_LIMITS.maxBytes
  ) {
    throw new TemplateError(
      'BAD_REQUEST',
      'template_too_large',
      `The template has ${sanitized.nodes.length} nodes and ${bytes} bytes; the limits are ${TEMPLATE_LIMITS.maxNodes} nodes and ${TEMPLATE_LIMITS.maxBytes} bytes`,
    );
  }

  const parsed = parseBoardTemplate(sanitized);

  if (!parsed.ok) {
    throw new TemplateError(
      'BAD_REQUEST',
      'invalid_template',
      'The selected nodes do not make a valid template',
      parsed.issues,
    );
  }

  const created = await db.template.createTemplate(
    {
      name: input.name,
      description: input.description ?? null,
      data: parsed.data,
      createdBy: userId,
      ...scope,
    },
    quotaOf(scope),
  );

  if (!created.ok) {
    throw limitReached(scope, created.count);
  }

  const { row } = created;
  const teamName = scope.teamId
    ? ((await db.team.getTeam(scope.teamId))?.name ?? null)
    : null;

  // stored layers are kept as they are, so layer_admin_only doesn't apply
  const lint = lintNodes(
    parsed.data.nodes.map((node) => ({
      id: node.ref,
      type: node.type,
      content: node.content,
    })),
    { isAdmin: true },
  );

  return {
    template: toSummary({ ...row, teamName }, 'write'),
    dropped,
    detachedArrows,
    lint,
  };
}
