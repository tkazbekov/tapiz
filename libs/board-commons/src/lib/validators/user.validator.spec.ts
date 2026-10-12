import { describe, expect, it } from 'vitest';
import type { StateActions } from '../models/node.model';
import { userValidator } from './user.validator';

describe('userValidator', () => {
  const userId = 'user-1';

  // isGuest is set by the server only
  it.each(['add', 'patch'] as const)(
    'drops a client-sent isGuest on %s',
    (op) => {
      const result = userValidator(
        {
          op,
          data: {
            type: 'user',
            id: userId,
            content: {
              visible: true,
              cursor: { x: 1, y: 2 },
              zoom: 1,
              isGuest: false,
              name: 'Someone else',
            },
          },
        } as StateActions,
        [],
        userId,
      );

      expect(result).toEqual({
        op,
        data: {
          type: 'user',
          id: userId,
          content: { visible: true, cursor: { x: 1, y: 2 }, zoom: 1 },
        },
      });
    },
  );

  it('rejects changes to other users', () => {
    expect(
      userValidator(
        {
          op: 'patch',
          data: { type: 'user', id: 'user-2', content: { visible: true } },
        } as StateActions,
        [],
        userId,
      ),
    ).toEqual(false);
  });
});
