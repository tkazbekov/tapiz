import { SETTINGS_VALIDATOR } from './settings.validators.js';
import { TuNode } from '../models/node.model.js';

const state = {
  userId: 'user-1',
  nodes: [],
  isAdmin: true,
  boardId: 'board-1',
  userPrivateId: 'private-1',
};

const settingsNode = (content: Record<string, unknown>) =>
  ({ id: 'settings', type: 'settings', content }) as TuNode;

describe('SETTINGS_VALIDATOR', () => {
  it('fills defaults when adding settings', async () => {
    const result = await SETTINGS_VALIDATOR.add(settingsNode({}), state);

    expect(result.success).toBe(true);
    expect(result.success && result.data.content).toEqual({
      readOnly: false,
      anonymousMode: false,
      hideNoteAuthor: false,
      allowPublicPosts: false,
    });
  });

  it('only returns the patched keys', async () => {
    const result = await SETTINGS_VALIDATOR.patch(
      settingsNode({ backgroundColor: '#ffffff' }),
      { ...state, node: settingsNode({ readOnly: true }) },
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.content).toEqual({
      backgroundColor: '#ffffff',
    });
  });

  it('rejects patches from non admins', async () => {
    const result = await SETTINGS_VALIDATOR.patch(
      settingsNode({ readOnly: false }),
      { ...state, isAdmin: false, node: settingsNode({}) },
    );

    expect(result.success).toBe(false);
  });
});
