import { randomUUID } from 'node:crypto';
import {
  eq,
  and,
  or,
  desc,
  sql,
  gt,
  SQL,
  DrizzleQueryError,
} from 'drizzle-orm';
import { db } from './init-db.js';
import * as schema from '../schema.js';
import {
  Invitation,
  Role,
  UserInvitation,
  UserSettings,
} from '@tapiz/board-commons';

export async function getUser(id: string) {
  const users = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id));

  return users.at(0);
}

export async function getUserByName(name: string) {
  const users = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.name, name));

  return users[0];
}

// Emails are stored trimmed and lower-cased.
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email already in use');
  }
}

function isEmailTaken(e: unknown) {
  // drizzle wraps driver errors; the PostgresError is the cause.
  if (e instanceof DrizzleQueryError) {
    e = e.cause;
  }

  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    e.code === '23505' &&
    'constraint_name' in e &&
    e.constraint_name === 'accounts_email_unique'
  );
}

async function mapEmailTaken<T>(query: Promise<T>) {
  try {
    return await query;
  } catch (e) {
    if (isEmailTaken(e)) {
      throw new EmailTakenError();
    }

    throw e;
  }
}

export async function getUserByEmail(email: string) {
  const users = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.email, normalizeEmail(email)));

  return users.at(0);
}

export async function getUserByApiTokenHash(apiTokenHash: string) {
  const users = await db
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.apiTokenHash, apiTokenHash),
        eq(schema.accounts.isGuest, false),
      ),
    );

  return users.at(0);
}

export async function createAccount({
  id = randomUUID(),
  name,
  email,
  passwordHash,
}: {
  id?: string;
  name: string;
  email: string;
  passwordHash: string | null;
}) {
  const users = await mapEmailTaken(
    db
      .insert(schema.accounts)
      .values({ id, name, email: normalizeEmail(email), passwordHash })
      .returning(),
  );

  return users[0];
}

export async function createGuest({
  id = randomUUID(),
  name,
}: {
  id?: string;
  name: string;
}) {
  const users = await db
    .insert(schema.accounts)
    .values({ id, name, isGuest: true })
    .returning();

  return users[0];
}

// Same id, so board memberships, notes and notifications carry over. Returns
// undefined if the account is no longer a guest (a concurrent upgrade).
export async function upgradeGuest(
  id: string,
  {
    name,
    email,
    passwordHash,
  }: { name: string; email: string; passwordHash: string },
) {
  const users = await mapEmailTaken(
    db
      .update(schema.accounts)
      .set({
        isGuest: false,
        name,
        email: normalizeEmail(email),
        passwordHash,
      })
      .where(and(eq(schema.accounts.id, id), eq(schema.accounts.isGuest, true)))
      .returning(),
  );

  return users.at(0);
}

// Credentials changed: pending reset links and the API token stop working.
const credentialReset = {
  passwordResetHash: null,
  passwordResetExpiresAt: null,
  apiTokenHash: null,
  apiTokenCreatedAt: null,
};

export async function setPassword(id: string, passwordHash: string) {
  await db
    .update(schema.accounts)
    .set({ passwordHash, ...credentialReset })
    .where(eq(schema.accounts.id, id));
}

// Same password, stronger parameters. Only replaces the hash it was derived
// from, so a password change or reset made meanwhile is never undone.
export async function updatePasswordHash(
  id: string,
  oldHash: string,
  newHash: string,
) {
  await db
    .update(schema.accounts)
    .set({ passwordHash: newHash })
    .where(
      and(
        eq(schema.accounts.id, id),
        eq(schema.accounts.passwordHash, oldHash),
      ),
    );
}

function expiresIn(ttlMs: number): SQL {
  return sql`now() + ${ttlMs} * interval '1 millisecond'`;
}

export async function setPasswordReset(
  id: string,
  resetHash: string,
  ttlMs: number,
) {
  await db
    .update(schema.accounts)
    .set({
      passwordResetHash: resetHash,
      passwordResetExpiresAt: expiresIn(ttlMs),
    })
    .where(eq(schema.accounts.id, id));
}

// Single use: the matching row is updated and the hash cleared atomically.
// Completing a reset proves the mailbox, so it also verifies the email.
export async function consumePasswordReset(
  resetHash: string,
  passwordHash: string,
) {
  const users = await db
    .update(schema.accounts)
    .set({
      passwordHash,
      ...credentialReset,
      emailVerifiedAt: sql`now()`,
      emailVerifyHash: null,
      emailVerifyExpiresAt: null,
    })
    .where(
      and(
        eq(schema.accounts.passwordResetHash, resetHash),
        gt(schema.accounts.passwordResetExpiresAt, sql`now()`),
        eq(schema.accounts.isGuest, false),
      ),
    )
    .returning({ id: schema.accounts.id });

  return users.at(0)?.id ?? null;
}

export async function setEmailVerification(
  id: string,
  verifyHash: string,
  ttlMs: number,
) {
  await db
    .update(schema.accounts)
    .set({
      emailVerifyHash: verifyHash,
      emailVerifyExpiresAt: expiresIn(ttlMs),
    })
    .where(eq(schema.accounts.id, id));
}

export async function consumeEmailVerification(verifyHash: string) {
  const users = await db
    .update(schema.accounts)
    .set({
      emailVerifiedAt: sql`now()`,
      emailVerifyHash: null,
      emailVerifyExpiresAt: null,
    })
    .where(
      and(
        eq(schema.accounts.emailVerifyHash, verifyHash),
        gt(schema.accounts.emailVerifyExpiresAt, sql`now()`),
        eq(schema.accounts.isGuest, false),
      ),
    )
    .returning({ id: schema.accounts.id });

  return users.at(0)?.id ?? null;
}

export async function deleteAccount(userId: string): Promise<unknown> {
  return db.delete(schema.accounts).where(eq(schema.accounts.id, userId));
}

export async function updateUserSettings(
  userId: string,
  settings: UserSettings,
) {
  const users = await db
    .update(schema.accounts)
    .set({ settings })
    .where(eq(schema.accounts.id, userId))
    .returning({ settings: schema.accounts.settings });

  return users.at(0)?.settings;
}

export async function getUserApiTokenInfo(userId: string) {
  const users = await db
    .select({
      apiTokenHash: schema.accounts.apiTokenHash,
      apiTokenCreatedAt: schema.accounts.apiTokenCreatedAt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, userId));

  const user = users.at(0);

  if (!user) {
    return null;
  }

  return {
    hasToken: !!user.apiTokenHash,
    createdAt: user.apiTokenCreatedAt,
  };
}

export async function updateUserApiToken(userId: string, apiTokenHash: string) {
  const users = await db
    .update(schema.accounts)
    .set({
      apiTokenHash,
      apiTokenCreatedAt: sql`now()`,
    })
    .where(eq(schema.accounts.id, userId))
    .returning({
      apiTokenCreatedAt: schema.accounts.apiTokenCreatedAt,
    });

  return users.at(0)?.apiTokenCreatedAt;
}

export async function invite(
  userId: string,
  inviterId: string,
  content: {
    teamId?: string;
    boardId?: string;
  },
  role: Role,
) {
  const invitation = await db
    .insert(schema.invitations)
    .values({
      userId,
      inviterId,
      ...content,
      role,
    })
    .returning();

  return {
    id: invitation[0].id,
    userId: invitation[0].userId,
    role: invitation[0].role,
  } as Invitation;
}

export async function inviteByEmail(
  email: string,
  inviterId: string,
  content: {
    teamId?: string;
    boardId?: string;
  },
  role: Role,
) {
  const invitation = await db
    .insert(schema.invitations)
    .values({
      email: normalizeEmail(email),
      inviterId,
      ...content,
      role,
    })
    .returning();

  return {
    id: invitation[0].id,
    email: invitation[0].email,
    role: invitation[0].role,
  } as Invitation;
}

export function addTeamMember(
  userId: string,
  teamId: string,
  role: 'admin' | 'member',
) {
  return db.insert(schema.teamMembers).values({
    accountId: userId,
    teamId,
    role,
  });
}

export function addBoardMember(
  userId: string,
  boardId: string,
  role: 'admin' | 'member' | 'guest',
) {
  return db.insert(schema.acountsToBoards).values({
    accountId: userId,
    boardId,
    role,
  });
}

// `email` only for verified addresses; otherwise only invitations sent to the
// account itself can be accepted.
export async function acceptInvitation(
  userId: string,
  email: string | null,
  invitationId: string,
) {
  const invitations = await db
    .select()
    .from(schema.invitations)
    .where(
      and(
        eq(schema.invitations.id, invitationId),
        or(
          eq(schema.invitations.userId, userId),
          email
            ? eq(schema.invitations.email, normalizeEmail(email))
            : undefined,
        ),
      ),
    );

  if (!invitations.length) {
    return;
  }

  const invitation = invitations[0];

  if (invitation.teamId && invitation.role !== 'guest') {
    await addTeamMember(userId, invitation.teamId, invitation.role);
  } else if (invitation.boardId) {
    await addBoardMember(userId, invitation.boardId, invitation.role);
  }

  await db
    .delete(schema.invitations)
    .where(eq(schema.invitations.id, invitationId));

  return true;
}

export async function getUserInvitations(
  userId: string,
): Promise<UserInvitation[]> {
  const invitations = await db
    .select()
    .from(schema.invitations)
    .leftJoin(schema.teams, eq(schema.invitations.teamId, schema.teams.id))
    .where(eq(schema.invitations.userId, userId));

  return invitations.map((invitation) => {
    return {
      id: invitation.invitations.id,
      role: invitation.invitations.role,
      team: invitation.teams,
    } as UserInvitation;
  });
}

export async function getUserInvitationsByEmail(
  email: string,
): Promise<UserInvitation[]> {
  const invitations = await db
    .select()
    .from(schema.invitations)
    .leftJoin(schema.teams, eq(schema.invitations.teamId, schema.teams.id))
    .where(eq(schema.invitations.email, normalizeEmail(email)));

  return invitations.map((invitation) => {
    return {
      id: invitation.invitations.id,
      role: invitation.invitations.role,
      team: invitation.teams,
    } as UserInvitation;
  });
}

export async function getInvitation(id: string) {
  const invitations = await db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.id, id));

  return invitations[0];
}

export async function deleteInvitation(id: string) {
  return db.delete(schema.invitations).where(eq(schema.invitations.id, id));
}

export async function editInvitationRole(id: string, role: Role) {
  return db
    .update(schema.invitations)
    .set({ role })
    .where(eq(schema.invitations.id, id));
}

export async function mentionUser(
  boardId: string,
  userId: string,
  nodeId?: string,
) {
  return db
    .insert(schema.notifications)
    .values({ boardId, userId, nodeId, type: 'mention' });
}

export async function getUserNotifications(
  userId: string,
  offset = 0,
  limit = 10,
) {
  const notifications = await db
    .select({
      id: schema.notifications.id,
      notificationId: schema.notifications.id,
      boardId: schema.notifications.boardId,
      userId: schema.notifications.userId,
      nodeId: schema.notifications.nodeId,
      createdAt: schema.notifications.createdAt,
      type: schema.notifications.type,
      userName: schema.accounts.name,
      boardName: schema.boards.name,
    })
    .from(schema.notifications)
    .leftJoin(
      schema.accounts,
      eq(schema.notifications.userId, schema.accounts.id),
    )
    .leftJoin(schema.boards, eq(schema.notifications.boardId, schema.boards.id))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit)
    .offset(offset)
    .where(eq(schema.notifications.userId, userId));

  return notifications;
}

export async function getUserNotificationsCount(
  userId: string,
): Promise<number> {
  const totalCount = await db
    .select({
      count: sql`COUNT(*)`,
    })
    .from(schema.notifications)
    .where(eq(schema.notifications.userId, userId));

  return totalCount[0].count as number;
}

export async function clearUserNotifications(userId: string) {
  return db
    .delete(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
}
