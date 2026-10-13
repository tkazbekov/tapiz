import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { UserSettings, defaultUserSettings } from '@tapiz/board-commons';
import { DrizzleQueryError, eq } from 'drizzle-orm';
import { db, psqlClient, startDB } from './db/init-db';
import { accounts, boardTemplates, boards, teamMembers, teams } from './schema';

const createdUserIds: string[] = [];
const createdTeamIds: string[] = [];
const createdBoardIds: string[] = [];

async function insertUser(settings?: UserSettings) {
  const id = randomUUID();

  createdUserIds.push(id);
  await db.insert(accounts).values({
    id,
    name: 'Schema test user',
    email: `${id}@tapiz.test`,
    ...(settings ? { settings } : {}),
  });

  return id;
}

async function readSettings(id: string) {
  const rows = await db
    .select({ settings: accounts.settings })
    .from(accounts)
    .where(eq(accounts.id, id));

  return rows.at(0)?.settings;
}

// Name of the constraint a failed query violated.
async function violatedConstraint(query: Promise<unknown>) {
  try {
    await query;
  } catch (e) {
    const cause = e instanceof DrizzleQueryError ? e.cause : e;

    return (cause as { constraint_name?: string }).constraint_name;
  }

  return undefined;
}

describe('schema', () => {
  beforeAll(async () => {
    await startDB();
  });

  afterEach(async () => {
    const userIds = createdUserIds.splice(0);
    const teamIds = createdTeamIds.splice(0);
    const boardIds = createdBoardIds.splice(0);

    await Promise.all([
      ...userIds.map((id) => db.delete(accounts).where(eq(accounts.id, id))),
      ...teamIds.map((id) => db.delete(teams).where(eq(teams.id, id))),
      ...boardIds.map((id) => db.delete(boards).where(eq(boards.id, id))),
    ]);
  });

  describe('accounts settings', () => {
    it('defaults new accounts to the default user settings', async () => {
      const userId = await insertUser();

      expect(await readSettings(userId)).toEqual(defaultUserSettings);
      expect((await readSettings(userId))?.wheelInputMode).toBe('auto');
    });

    it('keeps an explicit wheel input mode', async () => {
      const userId = await insertUser({
        ...defaultUserSettings,
        wheelInputMode: 'trackpad',
      });

      expect((await readSettings(userId))?.wheelInputMode).toBe('trackpad');
    });
  });

  describe('accounts_identity_chk', () => {
    it('allows a guest without email or credentials', async () => {
      const id = randomUUID();

      createdUserIds.push(id);

      await expect(
        db.insert(accounts).values({ id, name: 'Guest', isGuest: true }),
      ).resolves.toBeDefined();
    });

    it('rejects a registered account without email', async () => {
      const id = randomUUID();

      createdUserIds.push(id);

      expect(
        await violatedConstraint(
          db.insert(accounts).values({ id, name: 'No email' }),
        ),
      ).toBe('accounts_identity_chk');
    });

    it('rejects a guest with an email or password', async () => {
      const id = randomUUID();

      createdUserIds.push(id);

      expect(
        await violatedConstraint(
          db.insert(accounts).values({
            id,
            name: 'Guest',
            isGuest: true,
            email: `${id}@tapiz.test`,
          }),
        ),
      ).toBe('accounts_identity_chk');

      expect(
        await violatedConstraint(
          db.insert(accounts).values({
            id,
            name: 'Guest',
            isGuest: true,
            passwordHash: 'scrypt$x',
          }),
        ),
      ).toBe('accounts_identity_chk');
    });
  });

  describe('team_members_role_chk', () => {
    it('rejects guest team members', async () => {
      const userId = await insertUser();
      const [team] = await db
        .insert(teams)
        .values({ name: 'Schema test team' })
        .returning();

      createdTeamIds.push(team.id);

      expect(
        await violatedConstraint(
          db.insert(teamMembers).values({
            teamId: team.id,
            accountId: userId,
            // the column type excludes guests; the database must too
            role: 'guest' as 'member',
          }),
        ),
      ).toBe('team_members_role_chk');

      await expect(
        db
          .insert(teamMembers)
          .values({ teamId: team.id, accountId: userId, role: 'admin' }),
      ).resolves.toBeDefined();
    });
  });

  describe('board_templates_scope_chk', () => {
    const template = {
      name: 'Schema test template',
      data: {
        version: 1 as const,
        size: { width: 0, height: 0 },
        nodes: [],
      },
      nodeCount: 0,
      width: 0,
      height: 0,
    };

    const insertTeam = async () => {
      const [team] = await db
        .insert(teams)
        .values({ name: 'Schema test team' })
        .returning();

      createdTeamIds.push(team.id);

      return team.id;
    };

    it('rejects a template with both an account and a team', async () => {
      const accountId = await insertUser();
      const teamId = await insertTeam();

      expect(
        await violatedConstraint(
          db.insert(boardTemplates).values({ ...template, accountId, teamId }),
        ),
      ).toBe('board_templates_scope_chk');
    });

    it('rejects a template with neither an account nor a team', async () => {
      expect(
        await violatedConstraint(db.insert(boardTemplates).values(template)),
      ).toBe('board_templates_scope_chk');
    });

    it('allows a personal or a team template', async () => {
      const accountId = await insertUser();
      const teamId = await insertTeam();

      // both rows go with their account or team in afterEach
      await expect(
        db.insert(boardTemplates).values({ ...template, accountId }),
      ).resolves.toBeDefined();
      await expect(
        db
          .insert(boardTemplates)
          .values({ ...template, teamId, createdBy: accountId }),
      ).resolves.toBeDefined();
    });

    it('keeps a team template when its creator is deleted', async () => {
      const createdBy = await insertUser();
      const teamId = await insertTeam();
      const [row] = await db
        .insert(boardTemplates)
        .values({ ...template, teamId, createdBy })
        .returning();

      await db.delete(accounts).where(eq(accounts.id, createdBy));

      const rows = await db
        .select({ createdBy: boardTemplates.createdBy })
        .from(boardTemplates)
        .where(eq(boardTemplates.id, row.id));

      expect(rows).toEqual([{ createdBy: null }]);
    });
  });

  describe('timestamps', () => {
    it('reads timestamps without time zone as ISO-8601 UTC strings', async () => {
      const [board] = await db
        .insert(boards)
        .values({ name: 'Schema test board', board: [] })
        .returning();

      createdBoardIds.push(board.id);

      expect(board.createdAt).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
      );
      expect(
        Math.abs(new Date(board.createdAt).getTime() - Date.now()),
      ).toBeLessThan(60_000);
    });

    // now() defaults write the session's local time into `timestamp` columns
    // read back as UTC, so the session must be UTC whatever the server's
    // own time zone is.
    it('pins the database session time zone to UTC', async () => {
      const [{ TimeZone }] = await psqlClient`SHOW TimeZone`;

      expect(TimeZone).toBe('UTC');
    });
  });
});
