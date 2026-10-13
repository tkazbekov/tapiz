import { describe, expect, it } from 'vitest';
import { settingsAction } from './settings-action';

describe('settingsAction', () => {
  it('patches the settings node', () => {
    expect(
      settingsAction(
        { id: 'settings-1', type: 'settings', content: {} },
        { notesHidden: true },
      ),
    ).toEqual({
      op: 'patch',
      data: {
        id: 'settings-1',
        type: 'settings',
        content: { notesHidden: true },
      },
    });
  });

  it('adds the settings node when the board has none', () => {
    const action = settingsAction(undefined, { notesHidden: true });

    expect(action.op).toBe('add');
    expect(action.data).toEqual(
      expect.objectContaining({
        type: 'settings',
        content: { notesHidden: true },
      }),
    );
    expect(action.data.id).toBeTruthy();
  });
});
