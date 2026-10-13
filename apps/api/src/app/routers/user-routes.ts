import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  participantProcedure,
  protectedProcedure,
  requireSessionAuth,
  router,
} from '../trpc.js';
import db from '../db/index.js';
import { getUserInvitationsByEmail, normalizeEmail } from '../db/user-db.js';
import { userSettingsValidator } from '@tapiz/board-commons/validators/user-settings.validator.js';
import { withDefaultUserSettings } from '@tapiz/board-commons';
import { generateApiToken, hashApiToken } from '../api-token.js';
import { getServer, revokeBoardAccess } from '../global.js';
import { deleteBoardFiles } from '../file-upload.js';
import { clearSessionCookie } from '../auth/session.js';
import { toAuthUser } from './auth-routes.js';

export const userRouter = router({
  removeAccount: protectedProcedure
    .use(requireSessionAuth)
    .mutation(async (req) => {
      const userId = req.ctx.user.sub;

      // Team boards cascade with their team, so teams go first.
      for (const team of await db.team.getUserTeams(userId)) {
        const members = await db.team.getTeamMembers(team.id);

        if (members.length === 1) {
          const boards = await db.board.getBoardsByTeam(team.id);

          for (const board of boards) {
            await deleteBoardFiles(board.id);
          }

          await db.team.deleteTeam(team.id);
          boards.forEach((board) => revokeBoardAccess(board.id));
          continue;
        }

        const others = members.filter((member) => member.id !== userId);

        if (!others.some((member) => member.role === 'admin')) {
          await db.team.changeRole(team.id, others[0].id, 'admin');
        }
      }

      for (const board of await db.board.getAdminBoardIds(userId)) {
        // team admins keep administering team boards
        if (board.teamId) {
          continue;
        }

        const members = (await db.board.getBoardUsers(board.id)).filter(
          (member) => member.id !== userId,
        );

        if (members.some((member) => member.role === 'admin')) {
          continue;
        }

        // guests can't administer boards
        const newOwner = members.find((member) => !member.isGuest);

        if (newOwner) {
          await db.board.changeRole(board.id, newOwner.id, 'admin');
        } else {
          await db.board.deleteBoard(board.id);
          revokeBoardAccess(board.id);
        }
      }

      // sessions cascade with the account
      await db.user.deleteAccount(userId);

      getServer()?.disconnectAccount(userId, 'account_deleted');
      clearSessionCookie(req.ctx.res);

      return {
        success: true,
      };
    }),
  user: participantProcedure.query(async (req) => {
    const user = await db.user.getUser(req.ctx.user.sub);

    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    return toAuthUser(user);
  }),
  settings: participantProcedure.query(async (req) => {
    const user = await db.user.getUser(req.ctx.user.sub);

    return withDefaultUserSettings(user?.settings);
  }),
  updateSettings: participantProcedure
    .input(userSettingsValidator)
    .mutation(async (req) => {
      const settings = withDefaultUserSettings(req.input);
      const savedSettings = await db.user.updateUserSettings(
        req.ctx.user.sub,
        settings,
      );

      return withDefaultUserSettings(savedSettings);
    }),
  apiToken: protectedProcedure.query(async (req) => {
    const tokenInfo = await db.user.getUserApiTokenInfo(req.ctx.user.sub);

    return tokenInfo ?? { hasToken: false, createdAt: null };
  }),
  generateApiToken: protectedProcedure
    .use(requireSessionAuth)
    .mutation(async (req) => {
      const token = generateApiToken();
      const createdAt = await db.user.updateUserApiToken(
        req.ctx.user.sub,
        hashApiToken(token),
        req.ctx.user.sessionId,
      );

      // the session ended (logout, password reset) while this ran
      if (!createdAt) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }

      return {
        token,
        createdAt,
      };
    }),
  invites: protectedProcedure.query(async (req) => {
    // invitations sent to an address only reach a verified owner of it
    const invitationsEmail = req.ctx.user.emailVerified
      ? await getUserInvitationsByEmail(req.ctx.user.email)
      : [];
    const invitations = await db.user.getUserInvitations(req.ctx.user.sub);

    return [...invitationsEmail, ...invitations];
  }),
  acceptInvite: protectedProcedure
    .input(z.object({ inviteId: z.uuid() }))
    .mutation(async (req) => {
      const result = await db.user.acceptInvitation(
        req.ctx.user.sub,
        req.ctx.user.emailVerified ? req.ctx.user.email : null,
        req.input.inviteId,
      );

      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      return {
        success: true,
      };
    }),
  cancelInvite: protectedProcedure
    .input(z.object({ inviteId: z.uuid() }))
    .mutation(async (req) => {
      const invitation = await db.user.getInvitation(req.input.inviteId);

      if (!invitation) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      let authError = false;

      if (
        invitation.inviterId !== req.ctx.user.sub &&
        invitation.userId !== req.ctx.user.sub &&
        !(
          req.ctx.user.emailVerified &&
          invitation.email === normalizeEmail(req.ctx.user.email)
        )
      ) {
        if (invitation.teamId) {
          const admins = await db.team.getTeamAdmins(invitation.teamId);

          const isAdmin = !!admins.find(
            (admin) => admin.accountId === req.ctx.user.sub,
          );

          if (!isAdmin) {
            authError = true;
          }
        } else if (invitation.boardId) {
          const admins = await db.board.getBoardAdmins(invitation.boardId);

          const isAdmin = admins.includes(req.ctx.user.sub);

          if (!isAdmin) {
            authError = true;
          }
        }
      }

      if (authError) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      await db.user.deleteInvitation(req.input.inviteId);

      return {
        success: true,
      };
    }),
  notifications: participantProcedure
    .input(z.object({ offset: z.number().int().min(0).optional().default(0) }))
    .query(async (req) => {
      const notifications = await db.user.getUserNotifications(
        req.ctx.user.sub,
        req.input.offset,
      );

      const size = await db.user.getUserNotificationsCount(req.ctx.user.sub);

      return {
        items: notifications,
        size,
      };
    }),
  clearNotifications: participantProcedure.mutation(async (req) => {
    await db.user.clearUserNotifications(req.ctx.user.sub);

    return {
      success: true,
    };
  }),
});
