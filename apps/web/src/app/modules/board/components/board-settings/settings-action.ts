import type { BoardSettings, StateActions, TuNode } from '@tapiz/board-commons';
import { uuid } from '@tapiz/utils/uuid';

// a patch of the settings node, or its add when the board has none yet
export function settingsAction(
  settings: TuNode<BoardSettings> | undefined,
  content: object,
): StateActions {
  if (settings) {
    return {
      data: {
        type: 'settings',
        id: settings.id,
        content,
      },
      op: 'patch',
    };
  }

  return {
    data: {
      type: 'settings',
      id: uuid(),
      content,
    },
    op: 'add',
  };
}
