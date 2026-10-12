import { z } from 'zod';
import {
  participantProcedure,
  protectedProcedure,
  teamProcedure,
  router,
  teamAdminProcedure,
  teamMemberProcedure,
  boardProcedure,
  boardAdminProcedure,
  boardMemberProcedure,
  boardAccountMemberProcedure,
} from '../app/trpc.js';

export const testRouter = router({
  participant: participantProcedure.query((req) => {
    return {
      input: req.input,
      ctx: req.ctx,
    };
  }),
  protected: protectedProcedure.query((req) => {
    return {
      input: req.input,
      ctx: req.ctx,
    };
  }),
  team: teamProcedure
    .input(
      z.object({
        teamId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  teamAdmin: teamAdminProcedure
    .input(
      z.object({
        teamId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  teamMember: teamMemberProcedure
    .input(
      z.object({
        teamId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  board: boardProcedure
    .input(
      z.object({
        boardId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  boardAdmin: boardAdminProcedure
    .input(
      z.object({
        boardId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  boardMember: boardMemberProcedure
    .input(
      z.object({
        boardId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
  boardAccountMember: boardAccountMemberProcedure
    .input(
      z.object({
        boardId: z.uuid(),
      }),
    )
    .query((req) => {
      return {
        input: req.input,
        ctx: req.ctx,
      };
    }),
});
