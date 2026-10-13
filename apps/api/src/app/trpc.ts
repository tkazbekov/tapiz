import { TRPCError, initTRPC } from '@trpc/server';
import type { AppContext } from './app.context.js';
import type { Principal } from './auth/principal.js';
import db from './db/index.js';
import { z } from 'zod';
import { DrizzleQueryError } from 'drizzle-orm';

const t = initTRPC.context<AppContext>().create({
  // drizzle's error message includes the SQL and its params (hashes, board
  // state); clients get the driver's message instead.
  errorFormatter({ shape, error }) {
    if (error.cause instanceof DrizzleQueryError) {
      return {
        ...shape,
        message: error.cause.cause?.message ?? 'Internal server error',
      };
    }

    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

const teamIdInput = z.object({ teamId: z.string().min(1) });

export type AccountPrincipal = Principal & { isGuest: false; email: string };

// Every existing denial stays UNAUTHORIZED. A guest on an account-only tier
// gets FORBIDDEN, which the web app does not treat as a lost session.
const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return next({ ctx: { user: ctx.user } });
});

const requireAccount = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  if (ctx.user.isGuest) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'ACCOUNT_REQUIRED' });
  }

  return next({ ctx: { user: ctx.user as AccountPrincipal } });
});

// API tokens can't mint a new token or delete the account. The local agent
// route (development only) turns a token into a session and so bypasses this.
export const requireSessionAuth = t.middleware(({ ctx, next }) => {
  if (ctx.user?.via !== 'session') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'SESSION_REQUIRED' });
  }

  return next();
});

// Accounts and guests.
export const participantProcedure = t.procedure.use(requireUser);

// Accounts only.
export const protectedProcedure = t.procedure.use(requireAccount);

// Runs before the procedure's own `.input()`, so it reads the raw input.
export const teamProcedure = protectedProcedure.use(async (opts) => {
  const parsed = teamIdInput.safeParse(await opts.getRawInput());

  if (!parsed.success) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }

  const team = await db.team.getTeam(parsed.data.teamId);

  if (!team) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }

  return opts.next({
    ctx: {
      team,
    },
  });
});

export const teamAdminProcedure = teamProcedure.use(async (opts) => {
  const userTeam = await db.team.getUserTeam(
    opts.ctx.team.id,
    opts.ctx.user.sub,
  );

  if (userTeam?.role !== 'admin') {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({
    ctx: {
      userTeam,
    },
  });
});

export const teamMemberProcedure = teamProcedure.use(async (opts) => {
  const userTeam = await db.team.getUserTeam(
    opts.ctx.team.id,
    opts.ctx.user.sub,
  );

  if (!userTeam) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({
    ctx: {
      userTeam,
    },
  });
});

export const boardProcedure = participantProcedure
  .input(z.object({ boardId: z.uuid() }))
  .use(async (opts) => {
    const board = await db.board.getBoard(opts.input.boardId);

    if (!board) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    return opts.next({
      ctx: {
        board,
      },
    });
  });

export const boardAdminProcedure = boardProcedure
  .use(requireAccount)
  .use(async (opts) => {
    const admins = await db.board.getBoardAdmins(opts.input.boardId);

    if (!admins.includes(opts.ctx.user.sub)) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    return opts.next();
  });

// Checks access and makes sure the user has an accounts_boards row.
async function requireBoardMember(boardId: string, userId: string) {
  const userBoard = await db.board.ensureBoardMember(boardId, userId);

  if (!userBoard) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return userBoard;
}

// Guests OK.
export const boardMemberProcedure = boardProcedure.use(async (opts) => {
  return opts.next({
    ctx: {
      userBoard: await requireBoardMember(
        opts.input.boardId,
        opts.ctx.user.sub,
      ),
    },
  });
});

// The account check comes first so no membership row is created for guests.
export const boardAccountMemberProcedure = boardProcedure
  .use(requireAccount)
  .use(async (opts) => {
    return opts.next({
      ctx: {
        userBoard: await requireBoardMember(
          opts.input.boardId,
          opts.ctx.user.sub,
        ),
      },
    });
  });
