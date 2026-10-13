import {
  BoardCommonActions,
  isNotesHidden,
  isUserNode,
  maskActionsForViewer,
  maskNodesForViewer,
  type BoardSettings,
  type StateActions,
  type TuNode,
  type UserNode,
} from '@tapiz/board-commons';
import type { Socket, Server as WsServer } from 'socket.io';
import { Client, type ClientIdentity } from './client.js';
import { createWsRateLimiter } from './ws-rate-limit.js';
import db from './db/index.js';

import { syncNodeBox } from '@tapiz/sync-node-box';
import { Subscription, throttleTime } from 'rxjs';
import { getAuthConfig } from './auth/config.js';
import { validateSessionToken } from './auth/session.js';
import { logError } from './log-error.js';

// Sessions are checked in the handshake middleware, so `connection` only
// fires for authenticated sockets. A rejected handshake reaches the browser
// as a `connect_error` with the reason as its message, and socket.io does not
// retry it on its own.
export function attachBoardSockets(
  io: WsServer,
  server: Server,
  parseCookie: (header: string) => Record<string, string>,
) {
  const cookiesOf = (socket: Socket) =>
    parseCookie(socket.request.headers.cookie ?? '');

  io.use((socket, next) => {
    server.authenticate(cookiesOf(socket)).then(
      (identity) => {
        if (!identity) {
          next(new Error('unauthenticated'));
          return;
        }

        socket.data.identity = identity;
        next();
      },
      (e) => {
        logError(e);
        next(new Error('server_error'));
      },
    );
  });

  io.on('connection', (socket) => {
    server.connection(socket, cookiesOf(socket));
  });
}

const isStateActionMessage = (
  msg: unknown,
): msg is { type: string; data: StateActions[] } =>
  (msg as { type?: unknown } | undefined)?.type ===
    BoardCommonActions.stateAction &&
  Array.isArray((msg as { data?: unknown }).data);

export class Server {
  public clients: Client[] = [];
  private state: Record<string, ReturnType<typeof syncNodeBox>> = {};
  private stateSubscriptions: Record<string, Subscription> = {};
  private boardSettings: Record<string, BoardSettings> = {};
  // last state writes of emptied boards, awaited before a board is reloaded
  private pendingFlush: Record<string, Promise<void>> = {};

  constructor(public io: WsServer) {}

  // Sockets authenticate once, in the handshake (see attachBoardSockets), and
  // never slide the session: they can't update the cookie.
  public async authenticate(
    cookies: Record<string, string>,
  ): Promise<ClientIdentity | null> {
    const session = await validateSessionToken(
      cookies[getAuthConfig().cookieName],
      { slide: false },
    );

    if (!session) {
      return null;
    }

    return {
      id: session.account.id,
      name: session.account.name,
      isGuest: session.account.isGuest,
      sessionId: session.sessionId,
    };
  }

  // Synchronous up to the client's listeners, so events the browser sends
  // right after connecting are handled.
  public connection(socket: Socket, cookies: Record<string, string>) {
    const identity: ClientIdentity | undefined = socket.data.identity;

    if (!identity) {
      socket.disconnect(true);
      return;
    }

    socket.use(
      createWsRateLimiter(() => {
        console.warn('Disconnecting a socket flooding events', identity.id);
        socket.disconnect(true);
      }),
    );

    const client = new Client(socket, this, identity);

    this.clients.push(client);
    // per-user room so user events reach every tab
    socket.join(`user:${identity.id}`);

    socket.on('disconnect', () => {
      this.clientClose(client);
    });

    // a logout after the handshake check could not see this client yet
    void validateSessionToken(cookies[getAuthConfig().cookieName], {
      slide: false,
    })
      .then((session) => {
        if (!session) {
          this.disconnectClients([client], 'session_ended');
        }
      })
      .catch((e) => {
        logError(e);
        this.disconnectClients([client], 'session_ended');
      });
  }

  private disconnectClients(clients: Client[], reason: string) {
    clients.forEach((client) => {
      client.socket.emit('auth_error', reason);
      client.close();
      client.socket.disconnect(true);
      this.clientClose(client);
    });
  }

  public disconnectSessions(sessionIds: string[], reason: string) {
    if (!sessionIds.length) {
      return;
    }

    this.disconnectClients(
      this.clients.filter(
        (client) => !!client.sessionId && sessionIds.includes(client.sessionId),
      ),
      reason,
    );
  }

  public disconnectAccount(accountId: string, reason: string) {
    this.disconnectClients(
      this.clients.filter((client) => client.id === accountId),
      reason,
    );
  }

  // Patches live clients of the account (a guest upgraded in place keeps its
  // id and sockets) and the user node on their boards.
  public updateIdentity(
    accountId: string,
    identity: Partial<Omit<ClientIdentity, 'id'>>,
  ) {
    const boardIds = new Set<string>();

    this.clients
      .filter((client) => client.id === accountId)
      .forEach((client) => {
        if (identity.name !== undefined) {
          client.username = identity.name;
        }

        if (identity.isGuest !== undefined) {
          client.isGuest = identity.isGuest;
        }

        if (identity.sessionId !== undefined) {
          client.sessionId = identity.sessionId;
        }

        if (client.boardId) {
          boardIds.add(client.boardId);
        }
      });

    const content: Partial<UserNode['content']> = {};

    if (identity.name !== undefined) {
      content.name = identity.name;
    }

    if (identity.isGuest !== undefined) {
      content.isGuest = identity.isGuest;
    }

    if (!Object.keys(content).length) {
      return;
    }

    boardIds.forEach((boardId) => {
      this.setState(boardId, (state) =>
        state.map((node) =>
          isUserNode(node) && node.id === accountId
            ? { ...node, content: { ...node.content, ...content } }
            : node,
        ),
      );

      const action: StateActions = {
        op: 'patch',
        data: { type: 'user', id: accountId, content },
      };

      this.io
        .to(boardId)
        .emit('board', [
          { type: BoardCommonActions.stateAction, data: [action] },
        ]);
    });
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
      // nothing to cache until the board loads, or the empty settings would
      // outlive the load
      if (!this.state[boardId]) {
        return {};
      }

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
          // the error carries the whole board as a query param
          db.board.updateBoard(boardId, state).catch((e) => logError(e));
        });
    }
  }

  public getBoard(boardId: string): TuNode[] | undefined {
    if (!this.state[boardId]) {
      return;
    }

    return this.state[boardId].get();
  }

  // the live board, else the stored one; a board unloaded a moment ago is
  // still being written, so wait for that write before reading it back
  public async readBoard(boardId: string): Promise<TuNode[] | undefined> {
    const live = this.getBoard(boardId);

    if (live) {
      return live;
    }

    await this.pendingFlush[boardId];

    return this.getBoard(boardId) ?? (await db.board.getBoard(boardId))?.board;
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
        .catch((e) => logError(e))
        .finally(() => {
          if (this.pendingFlush[boardId] === flush) {
            delete this.pendingFlush[boardId];
          }
        });

      this.pendingFlush[boardId] = flush;

      delete this.state[boardId];
    }

    delete this.boardSettings[boardId];

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
                isGuest: user.content.isGuest,
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

    // the first settings node arrives as an add, so any settings action
    // refreshes the cache
    const hasNewSettings = actions.some((it) => it.data.type === 'settings');

    if (hasNewSettings) {
      const settings = this.findBoardSettings(boardId);

      this.boardSettings[boardId] = settings;
    }

    return newState;
  }

  // while notes are hidden, note actions and their comments are sent to each
  // socket masked for its user
  public needsMasking(boardId: string, msgs: unknown[]) {
    const hasNotes = msgs.some(
      (msg) =>
        isStateActionMessage(msg) &&
        msg.data.some((action) => action.data.type === 'note' || action.parent),
    );

    // a board that isn't loaded can't tell, so emitMasked drops its notes
    if (!this.getBoard(boardId)) {
      return hasNotes;
    }

    return hasNotes && isNotesHidden(this.getBoardSettings(boardId));
  }

  // sends to every socket in the board room but the sender's
  public emitMasked(boardId: string, msgs: unknown[], senderSocketId?: string) {
    const nodes = this.getBoard(boardId);
    const sockets = this.io.of('/').adapter.rooms.get(boardId);

    if (!nodes || !sockets) {
      return;
    }

    const clients = new Map(this.clients.map((it) => [it.socket.id, it]));
    // one view per user, shared by its tabs
    const views = new Map<string, unknown[]>();

    const viewOf = (viewerId: string) =>
      msgs.flatMap((msg) => {
        if (!isStateActionMessage(msg)) {
          return [msg];
        }

        const data = maskActionsForViewer(msg.data, nodes, viewerId);

        return data.length ? [{ ...msg, data }] : [];
      });

    sockets.forEach((socketId) => {
      const viewer = clients.get(socketId);

      // a socket without a known user gets nothing rather than everything
      if (socketId === senderSocketId || !viewer) {
        return;
      }

      const view = views.get(viewer.id) ?? viewOf(viewer.id);

      views.set(viewer.id, view);

      if (view.length) {
        this.io.to(socketId).emit('board', view);
      }
    });
  }

  // hiding or revealing notes changes what every user may see
  public resyncBoard(boardId: string) {
    const nodes = this.getBoard(boardId);

    if (!nodes) {
      return;
    }

    const views = new Map<string, TuNode[]>();

    this.clients
      .filter((client) => client.boardId === boardId)
      .forEach((client) => {
        const view =
          views.get(client.id) ?? maskNodesForViewer(nodes, client.id);

        views.set(client.id, view);
        client.sendToClient({
          type: BoardCommonActions.resyncState,
          data: view,
        });
      });
  }

  public updateBoardName(boardId: string, name: string) {
    db.board.updateBoardName(boardId, name);
  }

  private updateBoard(boardId: string, state: TuNode[]) {
    this.state[boardId].update(() => state);
  }
}
