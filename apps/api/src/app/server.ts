import {
  isUserNode,
  type BoardSettings,
  type StateActions,
  type TuNode,
  type UserNode,
} from '@tapiz/board-commons';
import type { Socket, Server as WsServer } from 'socket.io';
import { Client } from './client.js';
import db from './db/index.js';

import { syncNodeBox } from '@tapiz/sync-node-box';
import { Subscription, throttleTime } from 'rxjs';
import { lucia, validateSession } from './auth.js';

export class Server {
  public clients: Client[] = [];
  private state: Record<string, ReturnType<typeof syncNodeBox>> = {};
  private stateSubscriptions: Record<string, Subscription> = {};
  private boardSettings: Record<string, BoardSettings> = {};
  // last state writes of emptied boards, awaited before a board is reloaded
  private pendingFlush: Record<string, Promise<void>> = {};

  constructor(public io: WsServer) {}

  public async connection(socket: Socket, cookies: Record<string, string>) {
    const sessionId = cookies[lucia.sessionCookieName];
    if (sessionId) {
      const { session, user } = await validateSession(sessionId);

      if (session && user) {
        const dbUser = await db.user.getUser(user.id);

        // the socket may have gone away while the session was validated
        if (dbUser && socket.connected) {
          const client = new Client(
            socket,
            this,
            dbUser.name,
            dbUser.id,
            dbUser.email,
          );

          this.clients.push(client);
          // per-user room so user events reach every tab
          socket.join(`user:${dbUser.id}`);

          socket.on('disconnect', () => {
            this.clientClose(client);
          });

          return;
        }
      }
    }

    socket.disconnect();
  }

  private findBoardSettings(boardId: string): BoardSettings {
    const board = this.getBoard(boardId);
    const defaultBoardSettings: BoardSettings = {};

    if (!board) {
      return defaultBoardSettings;
    }

    const boardSettings = board.find(
      (it): it is TuNode<BoardSettings> => it.type === 'settings',
    );

    return boardSettings?.content ?? defaultBoardSettings;
  }

  public getBoardSettings(boardId: string) {
    if (!this.boardSettings[boardId]) {
      this.boardSettings[boardId] = this.findBoardSettings(boardId);
    }

    return this.boardSettings[boardId];
  }

  public clientClose(client: Client) {
    this.clients = this.clients.filter((it) => it !== client);
  }

  public async createBoard(boardId: string) {
    await this.pendingFlush[boardId];

    if (!this.state[boardId]) {
      if (this.stateSubscriptions[boardId]) {
        this.emptyBoard(boardId);
      }

      const board = await db.board.getBoard(boardId);

      if (!board) {
        throw new Error('board not found');
      }

      const boardNodes = board.board ?? [];

      this.state[boardId] = syncNodeBox({ history: 0, log: false });

      this.updateBoard(
        boardId,
        boardNodes.map((it) => {
          if (!isUserNode(it)) {
            return it;
          }

          return {
            ...it,
            content: {
              ...it.content,
              connected: false,
              cursor: null,
            },
          } satisfies UserNode;
        }),
      );
      this.stateSubscriptions[boardId] = this.state[boardId]
        .sync()
        .pipe(throttleTime(2000))
        .subscribe((state) => {
          db.board.updateBoard(boardId, state).catch((e) => console.error(e));
        });
    }
  }

  public getBoard(boardId: string): TuNode[] | undefined {
    if (!this.state[boardId]) {
      return;
    }

    return this.state[boardId].get();
  }

  public setState(boardId: string, fn: (state: TuNode[]) => TuNode[]) {
    if (!this.state[boardId]) {
      return;
    }

    const nextState = fn(this.state[boardId].get());

    this.updateBoard(boardId, nextState);
  }

  public emptyBoard(boardId: string) {
    if (this.state[boardId]) {
      const flush: Promise<void> = db.board
        .updateBoard(boardId, this.state[boardId].get())
        .then(() => undefined)
        .catch((e) => console.error(e))
        .finally(() => {
          if (this.pendingFlush[boardId] === flush) {
            delete this.pendingFlush[boardId];
          }
        });

      this.pendingFlush[boardId] = flush;

      delete this.state[boardId];
    }

    if (this.stateSubscriptions[boardId]) {
      this.stateSubscriptions[boardId].unsubscribe();
      delete this.stateSubscriptions[boardId];
    }
  }

  public getStateBoardUsers(boardId: string) {
    const state = this.getBoard(boardId);

    return state?.filter((node) => node.type === 'user') ?? [];
  }

  public isUserInBoard(boardId: string, userId: UserNode['id']) {
    const users = this.getStateBoardUsers(boardId);

    return users.some((it) => it.id === userId);
  }

  public userJoin(boardId: string, user: UserNode) {
    const isAlreadyInState = this.isUserInBoard(boardId, user.id);
    const board = this.state[boardId];

    if (isAlreadyInState) {
      board.update((state) => {
        return state.map((it) => {
          if (it.id === user.id) {
            return {
              ...it,
              content: {
                ...it.content,
                name: user.content.name,
                connected: true,
              },
            };
          }

          return it;
        });
      });
    } else {
      board.update((state) => {
        state.push(user);

        return state;
      });
    }
  }

  public getBoardUsers(boardId: string) {
    return db.board.getBoardUsers(boardId);
  }

  public applyAction(boardId: string, actions: StateActions[]) {
    const newState = this.state[boardId].actions(actions);

    const hasNewSettings = actions.some(
      (it) => it.op === 'patch' && it.data.type === 'settings',
    );

    if (hasNewSettings) {
      const settings = this.findBoardSettings(boardId);

      this.boardSettings[boardId] = settings;
    }

    return newState;
  }

  public updateBoardName(boardId: string, name: string) {
    db.board.updateBoardName(boardId, name);
  }

  private updateBoard(boardId: string, state: TuNode[]) {
    this.state[boardId].update(() => state);
  }
}
