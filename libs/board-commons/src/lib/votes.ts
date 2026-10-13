import type { BoardSettings } from './models/board-settings.model.js';
import { isSettings } from './models/board-settings.model.js';
import { isGroup } from './models/group.model.js';
import type { StateActions, TuNode } from './models/node.model.js';
import { isNote } from './models/note.model.js';

export interface UserVote {
  userId: string;
  vote: number;
}

const isVotable = (node: TuNode) => isNote(node) || isGroup(node);

const votesOf = (content: unknown): UserVote[] | undefined => {
  const votes = (content as { votes?: unknown } | undefined)?.votes;

  return Array.isArray(votes) ? (votes as UserVote[]) : undefined;
};

export function ownVotes(votes: UserVote[] | undefined, userId: string) {
  return votes?.find((it) => it.userId === userId)?.vote ?? 0;
}

// notes and groups are always top-level nodes
export function countUserVotes(nodes: TuNode[], userId: string) {
  return nodes.reduce(
    (total, node) =>
      isVotable(node) ? total + ownVotes(votesOf(node.content), userId) : total,
    0,
  );
}

// null means unlimited
export function votesBudget(settings?: BoardSettings | null) {
  return settings?.votesPerUser ? settings.votesPerUser : null;
}

const dedupe = (votes: UserVote[]) =>
  votes.filter(
    (vote, index) =>
      votes.findIndex((it) => it.userId === vote.userId) === index,
  );

// keeps the position of the user's entry, appends a new one and drops it at 0
const withOwnVote = (votes: UserVote[], userId: string, vote: number) => {
  const own = { userId, vote };

  if (votes.some((it) => it.userId === userId)) {
    return votes.flatMap((it) =>
      it.userId === userId ? (vote ? [own] : []) : [it],
    );
  }

  return vote ? [...votes, own] : votes;
};

/**
 * The server owns every vote but the sender's: a patch only changes the
 * sender's entry of the stored votes, so stale arrays (undo, concurrent
 * clicks) can't overwrite other users. An add keeps the other entries as
 * sent (paste, undo of a remove).
 *
 * Increases are clamped to the board budget instead of rejected, because one
 * rejected action drops the whole batch. The tally runs across the batch.
 */
export function normalizeVoteActions(
  actions: StateActions[],
  nodes: TuNode[],
  userId: string,
): StateActions[] {
  const budget = votesBudget(nodes.find(isSettings)?.content);
  // votes per node id as the batch changes them, null once removed
  const latest = new Map<string, UserVote[] | null>();
  let used = countUserVotes(nodes, userId);

  const storedVotes = (id: string) => {
    if (latest.has(id)) {
      return latest.get(id) ?? null;
    }

    const node = nodes.find((it) => it.id === id);

    return node && isVotable(node) ? (votesOf(node.content) ?? []) : null;
  };

  const allowed = (prevOwn: number, incomingOwn: number) => {
    if (budget === null || incomingOwn <= prevOwn) {
      return incomingOwn;
    }

    return Math.min(incomingOwn, Math.max(prevOwn, prevOwn + budget - used));
  };

  return actions.map((action) => {
    if (
      action.parent ||
      (action.data.type !== 'note' && action.data.type !== 'group')
    ) {
      return action;
    }

    const id = action.data.id;
    const stored = storedVotes(id);

    if (action.op === 'remove') {
      used -= ownVotes(stored ?? [], userId);
      latest.set(id, null);

      return action;
    }

    const incoming = votesOf(action.data.content);

    // adding a node that already exists changes nothing
    if (!incoming || (action.op === 'add' && stored)) {
      return action;
    }

    const prevOwn = ownVotes(stored ?? [], userId);
    const own = allowed(prevOwn, ownVotes(incoming, userId));
    const base = dedupe(action.op === 'add' ? incoming : (stored ?? []));
    const votes = withOwnVote(base, userId, own);

    used += own - prevOwn;
    latest.set(id, votes);

    return {
      ...action,
      data: {
        ...action.data,
        content: { ...action.data.content, votes },
      },
    } as StateActions;
  });
}
