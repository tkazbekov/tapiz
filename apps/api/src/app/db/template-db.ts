import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { BoardTemplateData } from '@tapiz/board-commons';
import { db } from './init-db.js';
import * as schema from '../schema.js';
import type { TeamRole } from '../schema.js';

export type TemplateRow = typeof schema.boardTemplates.$inferSelect & {
  teamName: string | null;
};

// a list row: no `data`, plus the reader's role in the template's team
export type TemplateSummaryRow = Omit<TemplateRow, 'data'> & {
  memberRole: TeamRole | null;
};

const summaryColumns = {
  id: schema.boardTemplates.id,
  name: schema.boardTemplates.name,
  description: schema.boardTemplates.description,
  accountId: schema.boardTemplates.accountId,
  teamId: schema.boardTemplates.teamId,
  createdBy: schema.boardTemplates.createdBy,
  nodeCount: schema.boardTemplates.nodeCount,
  width: schema.boardTemplates.width,
  height: schema.boardTemplates.height,
  createdAt: schema.boardTemplates.createdAt,
  updatedAt: schema.boardTemplates.updatedAt,
  teamName: schema.teams.name,
};

/**
 * Personal templates plus those of the user's teams. `teamId` only narrows
 * that set, so passing another team's id returns nothing.
 */
export async function listTemplatesForUser(
  userId: string,
  options: { teamId?: string } = {},
): Promise<TemplateSummaryRow[]> {
  const userTeams = db
    .select({ teamId: schema.teamMembers.teamId })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.accountId, userId));

  return db
    .select({ ...summaryColumns, memberRole: schema.teamMembers.role })
    .from(schema.boardTemplates)
    .leftJoin(schema.teams, eq(schema.teams.id, schema.boardTemplates.teamId))
    .leftJoin(
      schema.teamMembers,
      and(
        eq(schema.teamMembers.teamId, schema.boardTemplates.teamId),
        eq(schema.teamMembers.accountId, userId),
      ),
    )
    .where(
      and(
        or(
          eq(schema.boardTemplates.accountId, userId),
          inArray(schema.boardTemplates.teamId, userTeams),
        ),
        options.teamId
          ? eq(schema.boardTemplates.teamId, options.teamId)
          : undefined,
      ),
    )
    .orderBy(desc(schema.boardTemplates.updatedAt));
}

export async function getTemplate(
  templateId: string,
): Promise<TemplateRow | undefined> {
  const rows = await db
    .select({ ...summaryColumns, data: schema.boardTemplates.data })
    .from(schema.boardTemplates)
    .leftJoin(schema.teams, eq(schema.teams.id, schema.boardTemplates.teamId))
    .where(eq(schema.boardTemplates.id, templateId));

  return rows.at(0);
}

type TemplateOwner = { accountId: string } | { teamId: string };

const ownerFilter = (owner: TemplateOwner) =>
  'accountId' in owner
    ? eq(schema.boardTemplates.accountId, owner.accountId)
    : eq(schema.boardTemplates.teamId, owner.teamId);

export async function countTemplates(
  owner: TemplateOwner,
  executor: Pick<typeof db, 'select'> = db,
): Promise<number> {
  const rows = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.boardTemplates)
    .where(ownerFilter(owner));

  return rows.at(0)?.count ?? 0;
}

export type CreateTemplateResult =
  | { ok: true; row: typeof schema.boardTemplates.$inferSelect }
  | { ok: false; count: number };

/**
 * Inserts the template unless its account or team already has `limit`
 * templates. Saves for the same owner take turns on an advisory lock, so
 * parallel saves can't go over the limit.
 */
export async function createTemplate(
  input: {
    name: string;
    description?: string | null;
    data: BoardTemplateData;
    createdBy: string;
  } & (
    { accountId: string; teamId: null } | { accountId: null; teamId: string }
  ),
  limit: number,
): Promise<CreateTemplateResult> {
  const owner: TemplateOwner =
    input.accountId === null
      ? { teamId: input.teamId }
      : { accountId: input.accountId };
  const lockKey =
    'accountId' in owner
      ? `board_templates:account:${owner.accountId}`
      : `board_templates:team:${owner.teamId}`;

  return db.transaction(async (tx) => {
    // released when the transaction ends
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const count = await countTemplates(owner, tx);

    if (count >= limit) {
      return { ok: false, count };
    }

    const rows = await tx
      .insert(schema.boardTemplates)
      .values({
        name: input.name,
        description: input.description ?? null,
        data: input.data,
        createdBy: input.createdBy,
        accountId: input.accountId,
        teamId: input.teamId,
        nodeCount: input.data.nodes.length,
        // rotated bounds can be fractional
        width: Math.ceil(input.data.size.width),
        height: Math.ceil(input.data.size.height),
      })
      .returning();

    return { ok: true, row: rows[0] };
  });
}

export async function deleteTemplate(templateId: string) {
  return db
    .delete(schema.boardTemplates)
    .where(eq(schema.boardTemplates.id, templateId));
}
