import { signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { BoardTemplateData, NodeAdd, TuNode } from '@tapiz/board-commons';
import { vi } from 'vitest';
import { BoardActions } from '../../actions/board.actions';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { BoardFacade } from '../../../../services/board-facade.service';
import { NotificationService } from '../../../../shared/notification/notification.service';

// shared by the template insert specs: a viewport at (-200, -100) zoom 0.5
// on a board with a user, a panel and a note

const lane = (ref: string, x: number) => ({
  ref,
  type: 'panel' as const,
  content: {
    position: { x, y: 0 },
    layer: 1 as const,
    width: 400,
    height: 1000,
    text: `<p>${ref}</p>`,
  },
});

export const lanesTemplate: BoardTemplateData = {
  version: 1,
  size: { width: 1400, height: 1000 },
  nodes: [
    lane('a', 0),
    lane('b', 500),
    lane('c', 1000),
    {
      ref: 'note',
      type: 'note',
      content: {
        position: { x: 50, y: 100 },
        layer: 0,
        width: 300,
        height: 300,
        text: 'hello',
        votes: [],
        emojis: [],
        drawing: [],
        ownerId: '',
      },
    },
  ],
};

export const boardNodes: TuNode[] = [
  { id: 'user-1', type: 'user', content: {} },
  {
    id: 'existing-panel',
    type: 'panel',
    content: { position: { x: 0, y: 0 } },
  },
  { id: 'existing-note', type: 'note', content: { position: { x: 0, y: 0 } } },
];

export function provideInsertMocks(dispatch: ReturnType<typeof vi.fn>) {
  return [
    {
      provide: Store,
      useValue: {
        dispatch,
        selectSignal: (selector: unknown) => {
          if (selector === boardPageFeature.selectPosition) {
            return signal({ x: -200, y: -100 });
          }

          if (selector === boardPageFeature.selectZoom) {
            return signal(0.5);
          }

          return signal(null);
        },
      },
    },
    {
      provide: BoardFacade,
      useValue: { nodes: signal(boardNodes), userId: signal('user-1') },
    },
    { provide: NotificationService, useValue: { open: vi.fn() } },
  ];
}

export function dispatchedAdds(dispatch: ReturnType<typeof vi.fn>) {
  const action = dispatch.mock.calls[0][0] as ReturnType<
    typeof BoardActions.batchNodeActions
  >;

  return action.actions as NodeAdd[];
}
