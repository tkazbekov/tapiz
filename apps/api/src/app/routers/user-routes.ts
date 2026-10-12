import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';
import db from '../db/index.js';
import { getUserInvitationsByEmail } from '../db/user-db.js';
import { lucia } from '../auth.js';
import { userSettingsValidator } from '@tapiz/board-commons/validators/user-settings.validator.js';
import { withDefaultUserSettings } from '@tapiz/board-commons';
import { generateApiToken, hashApiToken } from '../api-token.js';
import { revokeBoardAccess } from '../global.js';
import { deleteBoardFiles } from '../file-upload.js';

export const userRouter = router({
  removeAccount: protectedProcedure.mutation(async (req) => {
    const userId = req.ctx.user.sub;

    await lucia.invalidateUserSessions(userId);

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

      const newOwner = members.at(0);

      if (newOwner) {
        await db.board.changeRole(board.id, newOwner.id, 'admin');
      } else {
        await db.board.deleteBoard(board.id);
        revokeBoardAccess(board.id);
      }
    }

    await db.user.deleteAccount(userId);

    return {
      success: true,
    };
  }),
  user: protectedProcedure.query(async (req) => {
    const user = await db.user.getUser(req.ctx.user.sub);

    return {
      name: req.ctx.user.name,
      id: req.ctx.user.sub,
      picture: req.ctx.user.picture ?? '',
      settings: withDefaultUserSettings(user?.settings),
    };
  }),
  settings: protectedProcedure.query(async (req) => {
    const user = await db.user.getUser(req.ctx.user.sub);

    return withDefaultUserSettings(user?.settings);
  }),
  updateSettings: protectedProcedure
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
  generateApiToken: protectedProcedure.mutation(async (req) => {
    const token = generateApiToken();
    const createdAt = await db.user.updateUserApiToken(
      req.ctx.user.sub,
      hashApiToken(token),
    );

    return {
      token,
      createdAt,
    };
  }),
  invites: protectedProcedure.query(async (req) => {
    const email = req.ctx.user.email;

    const invitationsEmail = await getUserInvitationsByEmail(email);
    const invitations = await db.user.getUserInvitations(req.ctx.user.sub);

    return [...invitationsEmail, ...invitations];
  }),
  acceptInvite: protectedProcedure
    .input(z.object({ inviteId: z.uuid() }))
    .mutation(async (req) => {
      const result = await db.user.acceptInvitation(
        req.ctx.user.sub,
        req.ctx.user.email,
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
        invitation.email !== req.ctx.user.email
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
  logout: publicProcedure.query(async (req) => {
    if (req.ctx.user) {
      await lucia.invalidateUserSessions(req.ctx.user.sub);
    }

    return {
      success: true,
    };
  }),
  notifications: protectedProcedure
    .input(z.object({ offset: z.number().int().optional().default(0) }))
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
  clearNotifications: protectedProcedure.mutation(async (req) => {
    await db.user.clearUserNotifications(req.ctx.user.sub);

    return {
      success: true,
    };
  }),
});
