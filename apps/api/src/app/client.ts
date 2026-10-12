import {
  BoardCommonActions,
  StateActions,
  TuNode,
  UserNode,
} from '@tapiz/board-commons';
import { Server } from './server.js';
import { type Socket } from 'socket.io';
import db from './db/index.js';
import { validation } from './validation.js';
import { z } from 'zod';
import { haveAccess } from './db/board-db.js';
import { haveAccessTeam } from './db/team-db.js';

export interface ClientIdentity {
  id: string;
  name: string;
  isGuest: boolean;
  // null for MCP clients, which authenticate with an API token
  sessionId: string | null;
}

const subSchema = z.object({
  type: z.union([z.literal('board'), z.literal('team')]),
  id: z.string(),
});

export class Client {
  boardId?: string;
  teamId?: string;
  isAdmin!: boolean;
  sendTimeout?: ReturnType<typeof setTimeout>;
  pendingMsgs: unknown[] = [];
  correlationId = '';
  private privateId = '';
  // bumped by every join and leave so an older, still running join gives up
  private joinSeq = 0;
  id: string;
  username: string;
  isGuest: boolean;
  sessionId: string | null;

  constructor(
    public socket: Socket,
    private server: Server,
    identity: ClientIdentity,
  ) {
    this.id = identity.id;
    this.username = identity.name;
    this.isGuest = identity.isGuest;
    this.sessionId = identity.sessionId;

    this.socket.on('board', this.boardIncomingMessage.bind(this));
    this.socket.on('sub', this.subscriptorMessage.bind(this));
    this.socket.on('correlationId', (correlationId: string) => {
      this.correlationId = correlationId;
    });
    this.socket.on('disconnect', () => {
      this.leave();
    });
    this.socket.on('leaveBoard', () => {
      this.leave();
    });

    // simulate disconnect
    // setTimeout(() => {
    //   this.socket.conn.close();
    // }, 10000);
  }
  async subscriptorMessage(message: { type: 'board' | 'team'; id: string }) {
    try {
      const messageResult = subSchema.parse(message);

      const { type, id } = messageResult;

      if (type === 'board') {
        const validUser = await haveAccess(id, this.id);

        if (validUser) {
          this.socket.join(`board:${id}`);

          // access may have been revoked while it was checked
          if (!(await haveAccess(id, this.id))) {
            this.socket.leave(`board:${id}`);
          }
        } else {
          this.unauthorizedClose();
          return;
        }
      } else if (type === 'team') {
        const validUser = await haveAccessTeam(id, this.id);

        if (validUser) {
          this.socket.join(`team:${id}`);
        } else {
          this.unauthorizedClose();
          return;
        }
      }
    } catch {
      this.socket.disconnect();
    }
  }

  boardIncomingMessage(messages: string | unknown[]) {
    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    messages = (messages as unknown[]).filter((message) => !!message);

    void this.processMsg(messages).catch((e) => {
      console.error(e);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async processMsg(messages: any): Promise<StateActions[]> {
    if (messages.length) {
      if ('action' in messages[0] && messages[0].action === 'join') {
        await this.join(messages[0]);
      } else {
        const broadcast: Record<string, unknown>[] = [];
        const stateActions: Record<string, unknown>[] = [];

        for (const it of messages as Record<string, unknown>[]) {
          if (it['type'] === BoardCommonActions.broadcast) {
            broadcast.push(it);
          } else {
            stateActions.push(it);
          }
        }

        if (!this.boardId) {
          return [];
        }

        if (broadcast.length) {
          this.socket.to(this.boardId).emit('board', broadcast);
        }

        return this.parseStateActionMessage(
          stateActions as unknown as StateActions[],
        );
      }
    }

    return [];
  }

  async parseStateActionMessage(messages: StateActions[]) {
    if (!this.boardId) {
      return [];
    }

    const state = this.server.getBoard(this.boardId);

    if (!state) {
      return [];
    }

    const validationResult = await validation(
      messages,
      state,
      this.id,
      this.isAdmin,
      this.boardId,
      this.privateId,
    );

    if (!validationResult.length) {
      return [];
    }

    return this.updateSendAllStateActions(validationResult);
  }

  unauthorizedClose(disconnect = true) {
    this.socket.emit('error', 'unauthorized');

    if (disconnect) {
      this.socket.disconnect();
    }
  }

  async refreshAccess(boardId = this.boardId) {
    if (!boardId) {
      this.unauthorizedClose(false);
      return;
    }

    const haveAccess = await db.board.haveAccess(boardId, this.id);

    if (!haveAccess) {
      this.revokeBoard(boardId);
      return;
    }

    if (boardId === this.boardId) {
      await this.refreshIsAdmin();
    }
  }

  // Drops the board subscription room and, if the client is on that board,
  // leaves it so no further state actions are accepted.
  revokeBoard(boardId: string) {
    this.socket.leave(`board:${boardId}`);
    this.socket.leave(boardId);

    if (this.boardId !== boardId) {
      return;
    }

    this.close();
    this.unauthorizedClose(false);
  }

  private leave() {
    this.joinSeq++;
    this.close();
  }

  close() {
    if (!this.boardId) {
      return;
    }

    this.server.setState(this.boardId, (state) => {
      state = state.map((node) => {
        if (node.type !== 'user') {
          return node;
        }

        if (node.id === this.id) {
          return {
            ...node,
            content: {
              ...node.content,
              connected: false,
            },
          };
        }

        return node;
      });

      return state;
    });

    const action: StateActions = {
      data: {
        type: 'user',
        id: this.id,
        content: {
          connected: false,
          cursor: null,
        },
      },
      op: 'patch',
    };

    this.sendAll(this.boardId, this.getStateAction([action]));
    // leave first so the room size no longer counts this socket
    this.socket.leave(this.boardId);

    const roomSize =
      this.server.io.of('/').adapter.rooms.get(this.boardId)?.size || 0;

    if (!roomSize) {
      this.server.emptyBoard(this.boardId);
    }

    this.boardId = undefined;
    this.teamId = undefined;
  }

  private updateSendAllStateActions(actions: StateActions[]) {
    if (!this.boardId) {
      return [];
    }

    const settings = this.server.getBoardSettings(this.boardId);
    if (!this.isAdmin && settings.readOnly) {
      actions = actions.filter((it) => it.data.type === 'user');
    }

    if (!actions.length) {
      return [];
    }

    this.updateStateWithActions(actions);
    this.sendAll(this.boardId, this.getStateAction(actions));

    return actions;
  }

  async joinBoard(boardId: string) {
    await this.join({ boardId });
  }

  private async join(message: { boardId: string }) {
    const result = z.uuid().safeParse(message.boardId);

    if (!result.success) {
      this.unauthorizedClose();
      return;
    }

    const boardId = result.data;
    const joinId = ++this.joinSeq;

    // Nothing is mutated until access is confirmed.
    const boardUser = await db.board.ensureBoardMember(boardId, this.id);

    // a later join or a leave took over while access was checked
    if (joinId !== this.joinSeq) {
      return;
    }

    if (!boardUser) {
      this.unauthorizedClose();
      return;
    }

    if (this.boardId && this.boardId !== boardId) {
      this.close();
    }

    this.teamId = boardUser.teamId ?? undefined;
    this.boardId = boardId;
    // in the room before the state loads, so a client leaving meanwhile
    // doesn't empty the board under us
    this.socket.join(boardId);

    // A newer join or leave has already moved this client off the board (and
    // out of its room); only drop a board state nobody else is using.
    const isStale = () => {
      if (joinId === this.joinSeq && this.boardId === boardId) {
        return false;
      }

      if (!this.server.io.of('/').adapter.rooms.get(boardId)?.size) {
        this.server.emptyBoard(boardId);
      }

      return true;
    };

    try {
      await this.server.createBoard(boardId);

      if (isStale()) {
        return;
      }

      const user: UserNode = {
        type: 'user',
        id: this.id,
        content: {
          id: this.id,
          name: this.username,
          isGuest: this.isGuest,
          visible: false,
          connected: true,
          cursor: null,
        },
      };

      const isAlreadyInBoard = this.server.isUserInBoard(boardId, this.id);

      this.server.userJoin(boardId, user);

      const board = this.server.getBoard(boardId);

      if (!board) {
        return;
      }

      const userInBoard = board.find((it) => it.id === this.id) as UserNode;

      user.content.visible = userInBoard?.content.visible ?? false;

      await this.refreshIsAdmin();

      if (isStale()) {
        return;
      }

      this.privateId = boardUser.privateId;

      const userAction: StateActions = {
        data: user,
        op: isAlreadyInBoard ? 'patch' : 'add',
      };

      this.sendAll(boardId, this.getStateAction([userAction]));

      // access may have been revoked while joining
      const stillHasAccess = await db.board.haveAccess(boardId, this.id);

      if (isStale()) {
        return;
      }

      if (!stillHasAccess) {
        this.close();
        this.unauthorizedClose();
        return;
      }

      // re-subscribe to board events too: after a reconnect the client only
      // sends `join`
      this.socket.join(`board:${boardId}`);

      this.sendToClient(
        this.getSetStateAction(this.server.getBoard(boardId) ?? board),
      );
    } catch (e) {
      console.error(e);

      if (!isStale()) {
        this.close();
      }
    }
  }

  async refreshIsAdmin() {
    if (!this.boardId) {
      return;
    }

    const admins = await db.board.getBoardAdmins(this.boardId);

    // guests are never board admins
    this.isAdmin = !this.isGuest && admins.includes(this.id);
  }

  getSetStateAction(nodes: TuNode[]) {
    return {
      type: BoardCommonActions.setState,
      data: nodes,
    };
  }

  getStateAction(action: StateActions[]) {
    return {
      type: BoardCommonActions.stateAction,
      data: action,
    };
  }

  sendToClient(msg: unknown) {
    this.socket.emit('board', [msg]);
  }

  sendAll(boardId: string, msg: unknown) {
    this.pendingMsgs.push(msg);

    if (this.sendTimeout) {
      return;
    }

    this.sendTimeout = setTimeout(() => {
      // send to all users in boardId but client
      this.socket.to(boardId).emit('board', this.pendingMsgs);
      this.pendingMsgs = [];
      this.sendTimeout = undefined;
    }, 50);
  }

  private updateStateWithActions(actions: StateActions[]) {
    if (!this.boardId) {
      return;
    }

    this.server.applyAction(this.boardId, actions);
  }
}
