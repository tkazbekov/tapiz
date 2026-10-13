import type { StateActions, TuNode } from './models/node.model.js';
import {
  countUserVotes,
  normalizeVoteActions,
  ownVotes,
  votesBudget,
  type UserVote,
} from './votes.js';

const note = (id: string, votes: UserVote[]): TuNode => ({
  id,
  type: 'note',
  content: { text: '', ownerId: 'owner', votes },
});

const group = (id: string, votes: UserVote[]): TuNode => ({
  id,
  type: 'group',
  content: { title: '', votes },
});

const settings = (votesPerUser: number | null): TuNode => ({
  id: 'settings',
  type: 'settings',
  content: { votesPerUser },
});

const vote = (id: string, votes: UserVote[], type = 'note'): StateActions => ({
  op: 'patch',
  data: { id, type, content: { votes } },
});

const votesOf = (actions: StateActions[]) =>
  actions.map(
    (it) => (it.data as Partial<TuNode<{ votes?: UserVote[] }>>).content?.votes,
  );

describe('votes', () => {
  it('counts the votes of a user on notes and groups', () => {
    const nodes = [
      note('n1', [
        { userId: 'me', vote: 2 },
        { userId: 'other', vote: 5 },
      ]),
      group('g1', [{ userId: 'me', vote: 1 }]),
      {
        id: 'p1',
        type: 'panel',
        content: { votes: [{ userId: 'me', vote: 9 }] },
      },
    ];

    expect(countUserVotes(nodes, 'me')).toBe(3);
    expect(ownVotes([{ userId: 'me', vote: 2 }], 'nobody')).toBe(0);
  });

  it('treats null and 0 as an unlimited budget', () => {
    expect(votesBudget(undefined)).toBeNull();
    expect(votesBudget({ votesPerUser: null })).toBeNull();
    expect(votesBudget({ votesPerUser: 0 })).toBeNull();
    expect(votesBudget({ votesPerUser: 3 })).toBe(3);
  });

  it('ignores the entries of other users in a patch', () => {
    const nodes = [
      note('n1', [
        { userId: 'other', vote: 2 },
        { userId: 'me', vote: 1 },
      ]),
    ];

    const result = normalizeVoteActions(
      [vote('n1', [{ userId: 'me', vote: 2 }])],
      nodes,
      'me',
    );

    expect(votesOf(result)).toEqual([
      [
        { userId: 'other', vote: 2 },
        { userId: 'me', vote: 2 },
      ],
    ]);

    const zeroed = normalizeVoteActions(
      [vote('n1', [{ userId: 'other', vote: 0 }])],
      nodes,
      'me',
    );

    // a missing entry removes the sender's vote, never the others'
    expect(votesOf(zeroed)).toEqual([[{ userId: 'other', vote: 2 }]]);
  });

  it('only changes the sender entry when undo resends an old array', () => {
    const nodes = [
      note('n1', [
        { userId: 'me', vote: 2 },
        { userId: 'other', vote: 3 },
        { userId: 'late', vote: 1 },
      ]),
    ];

    // the array as it was before the sender's last click
    const result = normalizeVoteActions(
      [
        vote('n1', [
          { userId: 'me', vote: 1 },
          { userId: 'other', vote: 1 },
        ]),
      ],
      nodes,
      'me',
    );

    expect(votesOf(result)).toEqual([
      [
        { userId: 'me', vote: 1 },
        { userId: 'other', vote: 3 },
        { userId: 'late', vote: 1 },
      ],
    ]);
  });

  it('keeps the other entries of an add and dedupes them', () => {
    const result = normalizeVoteActions(
      [
        {
          op: 'add',
          data: note('n1', [
            { userId: 'other', vote: 2 },
            { userId: 'other', vote: 7 },
            { userId: 'me', vote: 1 },
          ]),
        },
      ],
      [],
      'me',
    );

    expect(votesOf(result)).toEqual([
      [
        { userId: 'other', vote: 2 },
        { userId: 'me', vote: 1 },
      ],
    ]);
  });

  it('clamps votes at the budget', () => {
    const nodes = [
      settings(3),
      note('n1', [{ userId: 'me', vote: 2 }]),
      note('n2', []),
    ];

    const result = normalizeVoteActions(
      [vote('n2', [{ userId: 'me', vote: 4 }])],
      nodes,
      'me',
    );

    expect(votesOf(result)).toEqual([[{ userId: 'me', vote: 1 }]]);
  });

  it('clamps a batch that crosses the budget', () => {
    const nodes = [
      settings(2),
      note('n1', [{ userId: 'me', vote: 1 }]),
      note('n2', [{ userId: 'other', vote: 1 }]),
    ];

    const result = normalizeVoteActions(
      [
        vote('n1', [{ userId: 'me', vote: 2 }]),
        vote('n2', [{ userId: 'me', vote: 1 }]),
        {
          op: 'patch',
          data: { id: 'n2', type: 'note', content: { text: 'x' } },
        },
      ],
      nodes,
      'me',
    );

    expect(votesOf(result)).toEqual([
      [{ userId: 'me', vote: 2 }],
      [{ userId: 'other', vote: 1 }],
      undefined,
    ]);
  });

  it('blocks increases but allows decreases after the budget is lowered', () => {
    const nodes = [
      settings(1),
      note('n1', [{ userId: 'me', vote: 2 }]),
      note('n2', [{ userId: 'me', vote: 1 }]),
    ];

    expect(
      votesOf(
        normalizeVoteActions(
          [vote('n1', [{ userId: 'me', vote: 3 }])],
          nodes,
          'me',
        ),
      ),
    ).toEqual([[{ userId: 'me', vote: 2 }]]);

    expect(
      votesOf(
        normalizeVoteActions(
          [vote('n1', [{ userId: 'me', vote: 1 }])],
          nodes,
          'me',
        ),
      ),
    ).toEqual([[{ userId: 'me', vote: 1 }]]);
  });

  it('refunds the votes of a removed node', () => {
    const nodes = [
      settings(2),
      note('n1', [{ userId: 'me', vote: 2 }]),
      note('n2', []),
    ];

    const result = normalizeVoteActions(
      [
        { op: 'remove', data: { id: 'n1', type: 'note' } },
        vote('n2', [{ userId: 'me', vote: 2 }]),
      ],
      nodes,
      'me',
    );

    expect(votesOf(result)[1]).toEqual([{ userId: 'me', vote: 2 }]);
  });

  it('does not limit votes when the budget is null or 0', () => {
    for (const budget of [null, 0]) {
      const result = normalizeVoteActions(
        [vote('n1', [{ userId: 'me', vote: 50 }])],
        [settings(budget), note('n1', [])],
        'me',
      );

      expect(votesOf(result)).toEqual([[{ userId: 'me', vote: 50 }]]);
    }
  });

  it('counts groups and notes against one budget', () => {
    const nodes = [
      settings(2),
      group('g1', [{ userId: 'me', vote: 1 }]),
      note('n1', []),
    ];

    const result = normalizeVoteActions(
      [
        vote('n1', [{ userId: 'me', vote: 1 }]),
        vote('g1', [{ userId: 'me', vote: 2 }], 'group'),
      ],
      nodes,
      'me',
    );

    expect(votesOf(result)).toEqual([
      [{ userId: 'me', vote: 1 }],
      [{ userId: 'me', vote: 1 }],
    ]);
  });
});
