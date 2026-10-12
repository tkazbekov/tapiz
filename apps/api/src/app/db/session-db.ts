import { and, eq, lte, ne, sql } from 'drizzle-orm';
import { db } from './init-db.js';
import * as schema from '../schema.js';

export async function insertSession(
  id: string,
  accountId: string,
  ttlMs: number,
) {
  const sessions = await db
    .insert(schema.sessions)
    .values({
      id,
      accountId,
      expiresAt: sql`now() + ${ttlMs} * interval '1 millisecond'`,
    })
    .returning({ expiresAt: schema.sessions.expiresAt });

  return sessions[0].expiresAt;
}

// Expiry and age are computed by the database clock.
export async function getSessionWithAccount(id: string) {
  const rows = await db
    .select({
      account: schema.accounts,
      expiresAt: schema.sessions.expiresAt,
      expired: sql<boolean>`${schema.sessions.expiresAt} <= now()`,
      remainingMs: sql<number>`extract(epoch from ${schema.sessions.expiresAt} - now()) * 1000`,
      ageMs: sql<number>`extract(epoch from now() - ${schema.sessions.createdAt}) * 1000`,
    })
    .from(schema.sessions)
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.sessions.accountId),
    )
    .where(eq(schema.sessions.id, id));

  const row = rows.at(0);

  if (!row) {
    return undefined;
  }

  return {
    ...row,
    remainingMs: Number(row.remainingMs),
    ageMs: Number(row.ageMs),
  };
}

export async function extendSession(id: string, ttlMs: number) {
  const sessions = await db
    .update(schema.sessions)
    .set({ expiresAt: sql`now() + ${ttlMs} * interval '1 millisecond'` })
    .where(eq(schema.sessions.id, id))
    .returning({ expiresAt: schema.sessions.expiresAt });

  return sessions.at(0)?.expiresAt;
}

export async function deleteSession(id: string) {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}

export async function deleteAccountSessions(
  accountId: string,
  exceptId?: string,
) {
  const sessions = await db
    .delete(schema.sessions)
    .where(
      and(
        eq(schema.sessions.accountId, accountId),
        exceptId ? ne(schema.sessions.id, exceptId) : undefined,
      ),
    )
    .returning({ id: schema.sessions.id });

  return sessions.map((session) => session.id);
}

export async function deleteExpiredSessions() {
  const sessions = await db
    .delete(schema.sessions)
    .where(lte(schema.sessions.expiresAt, sql`now()`))
    .returning({ id: schema.sessions.id });

  return sessions.map((session) => session.id);
}
