import { describe, expect, it } from 'vitest';
import { BoardUserInfo } from '@tapiz/board-commons';
import { BoardPageActions } from '../actions/board-page.actions';
import { boardPageFeature } from './boardPage.reducer';

describe('boardPage reducer', () => {
  const { reducer } = boardPageFeature;

  const boardLoaded = (isAdmin: boolean) => {
    const initial = reducer(
      undefined,
      BoardPageActions.initBoard({ userId: 'user-1' }),
    );

    return reducer(
      initial,
      BoardPageActions.fetchBoardSuccess({
        isAdmin,
        name: 'board',
        isPublic: false,
        privateId: 'private-1',
        teamName: 'team',
        teamId: 'team-1',
      }),
    );
  };

  const users: BoardUserInfo[] = [
    {
      id: 'user-2',
      name: 'Zoe',
      picture: null,
      role: 'admin',
      isGuest: false,
    },
    {
      id: 'user-1',
      name: 'Ana',
      picture: null,
      role: 'member',
      isGuest: false,
    },
  ];

  it('keeps a team admin as board admin when board users load', () => {
    const state = reducer(
      boardLoaded(true),
      BoardPageActions.setBoardUsers({ users }),
    );

    expect(state.isAdmin).toEqual(true);
    expect(state.boardUsers.map((it) => it.name)).toEqual(['Ana', 'Zoe']);
  });

  it('does not promote a member from the board users list', () => {
    const state = reducer(
      boardLoaded(false),
      BoardPageActions.setBoardUsers({
        users: users.map((it) => ({ ...it, role: 'admin' })),
      }),
    );

    expect(state.isAdmin).toEqual(false);
  });
});
