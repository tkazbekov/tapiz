import { router } from '../trpc.js';
import { teamRouter } from './team-routes.js';
import { boardRouter } from './board-routes.js';
import { userRouter } from './user-routes.js';
import { templateRouter } from './template-routes.js';

export const appRouter = router({
  user: userRouter,
  board: boardRouter,
  team: teamRouter,
  template: templateRouter,
});

export type AppRouter = typeof appRouter;
