import { type Server } from './server.js';
import db from './db/index.js';
import { logError } from './log-error.js';

let server: Server | null = null;

export function setServer(s: Server) {
  server = s;
}

export function getServer() {
  return server;
}

// Clients on the board plus sockets in its state room or subscribed to its
// `board:<id>` events.
function getBoardClients(boardId: string) {
  if (!server) {
    return [];
  }

  const rooms = server.io.of('/').adapter.rooms;
  const members = rooms.get(boardId);
  const subscribers = rooms.get(`board:${boardId}`);

  return server.clients.filter(
    (client) =>
      client.boardId === boardId ||
      (!!client.socket.id &&
        (!!members?.has(client.socket.id) ||
          !!subscribers?.has(client.socket.id))),
  );
}

export function checkBoardAccess(boardId: string) {
  getBoardClients(boardId).forEach((client) => {
    void client.refreshAccess(boardId).catch(logError);
  });
}

// Re-checks the team's boards and drops `team:<id>` subscribers that are no
// longer members.
export function checkTeamBoardsAccess(teamId: string) {
  if (!server) {
    return;
  }

  const currentServer = server;

  currentServer.clients
    .filter((client) => client.teamId === teamId)
    .forEach((client) => {
      void client.refreshAccess().catch(logError);
    });

  const teamRoom = `team:${teamId}`;
  const subscribers = currentServer.io.of('/').adapter.rooms.get(teamRoom);

  currentServer.clients
    .filter(
      (client) => !!client.socket.id && !!subscribers?.has(client.socket.id),
    )
    .forEach((client) => {
      void db.team
        .haveAccessTeam(teamId, client.id)
        .then((hasAccess) => {
          if (!hasAccess) {
            client.socket.leave(teamRoom);
          }
        })
        .catch(logError);
    });

  void db.board
    .getBoardsByTeam(teamId)
    .then((boards) => {
      boards.forEach((board) => checkBoardAccess(board.id));
    })
    .catch(logError);
}

export function revokeBoardAccess(boardId: string) {
  getBoardClients(boardId).forEach((client) => {
    client.revokeBoard(boardId);
  });
}
