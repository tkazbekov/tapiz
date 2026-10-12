import { TRPCError, initTRPC } from '@trpc/server';
import type { AppContext } from './app.context.js';
import db from './db/index.js';
import { z } from 'zod';

const t = initTRPC.context<AppContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

const teamIdInput = z.object({ teamId: z.string().min(1) });

export const protectedProcedure = t.procedure.use((opts) => {
  const { ctx } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({
    ctx: {
      user: ctx.user,
    },
  });
});

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

export const boardProcedure = protectedProcedure
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

export const boardAdminProcedure = boardProcedure.use(async (opts) => {
  const admins = await db.board.getBoardAdmins(opts.input.boardId);

  if (!admins.includes(opts.ctx.user.sub)) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next();
});

export const boardMemberProcedure = boardProcedure.use(async (opts) => {
  const { boardId } = opts.input;
  const userId = opts.ctx.user.sub;

  const userBoard = await db.board.ensureBoardMember(boardId, userId);

  if (!userBoard) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({
    ctx: {
      userBoard,
    },
  });
});
