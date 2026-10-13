import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import { getServer } from '../global.js';
import {
  TemplateError,
  deleteTemplateAsUser,
  getTemplateWithData,
  listTemplates,
  saveTemplateFromBoard,
} from '../template-service.js';

// a TemplateError would otherwise surface as a generic 500
async function mapTemplateError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TemplateError) {
      throw new TRPCError({
        code: error.code,
        message: error.message,
        cause: error,
      });
    }

    throw error;
  }
}

export const templateRouter = router({
  list: protectedProcedure
    .input(z.object({ teamId: z.uuid().optional() }).optional())
    .query((req) =>
      mapTemplateError(() =>
        listTemplates(req.ctx.user.sub, { teamId: req.input?.teamId }),
      ),
    ),
  get: protectedProcedure
    .input(z.object({ templateId: z.uuid() }))
    .query((req) =>
      mapTemplateError(() =>
        getTemplateWithData(req.input.templateId, req.ctx.user.sub),
      ),
    ),
  createFromBoard: protectedProcedure
    .input(
      z.object({
        boardId: z.uuid(),
        nodeIds: z.array(z.string().min(1).max(255)).min(1).max(500),
        name: z.string().trim().min(1).max(256),
        description: z.string().max(2000).optional(),
        scope: z.enum(['personal', 'team']),
        teamId: z.uuid().optional(),
      }),
    )
    .mutation((req) =>
      mapTemplateError(() =>
        saveTemplateFromBoard(getServer(), {
          userId: req.ctx.user.sub,
          ...req.input,
        }),
      ),
    ),
  delete: protectedProcedure
    .input(z.object({ templateId: z.uuid() }))
    .mutation(async (req) => {
      await mapTemplateError(() =>
        deleteTemplateAsUser(req.input.templateId, req.ctx.user.sub),
      );

      return { success: true };
    }),
});
