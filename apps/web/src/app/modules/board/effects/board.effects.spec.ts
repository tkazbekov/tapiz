import { TestBed } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { Action } from '@ngrx/store';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { StateActions, TuNode } from '@tapiz/board-commons';
import { BoardFacade } from '../../../services/board-facade.service';
import { BoardApiService } from '../../../services/board-api.service';
import { ConfigService } from '../../../services/config.service';
import { NotificationService } from '../../../shared/notification/notification.service';
import { WsService } from '../../ws/services/ws.service';
import { BoardActions } from '../actions/board.actions';
import { LiveReactionStore } from '../components/live-reaction/live-reaction.store';
import { PingStore } from '../components/ping/ping.store';
import { NodesActions } from '../services/nodes-actions';
import { BoardEffects } from './board.effects';

describe('BoardEffects', () => {
  let actions$: Subject<Action>;
  let effects: BoardEffects;
  let state: TuNode[];
  let setState: ReturnType<typeof vi.fn>;
  let applyActions: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    actions$ = new Subject<Action>();
    state = [];
    setState = vi.fn();
    applyActions = vi.fn();
    send = vi.fn();
    notify = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        BoardEffects,
        provideMockActions(() => actions$),
        provideMockStore(),
        { provide: Router, useValue: {} },
        { provide: WsService, useValue: { send } },
        { provide: BoardApiService, useValue: {} },
        {
          provide: BoardFacade,
          useValue: {
            setState,
            applyActions,
            get: () => state,
            userId: () => 'me',
          },
        },
        { provide: NodesActions, useValue: {} },
        { provide: ConfigService, useValue: { config: { DEMO: false } } },
        { provide: LiveReactionStore, useValue: {} },
        { provide: PingStore, useValue: {} },
        { provide: NotificationService, useValue: { open: notify } },
      ],
    });

    effects = TestBed.inject(BoardEffects);
  });

  it('replaces the board state on a resync', () => {
    const board: TuNode[] = [
      { id: 'settings', type: 'settings', content: { notesHidden: true } },
    ];

    effects.setState$.subscribe();
    actions$.next(BoardActions.resyncState({ data: board }));

    expect(setState).toHaveBeenCalledWith(board);
  });

  it('does not send edits of hidden notes the server would reject', () => {
    state = [
      { id: 'settings', type: 'settings', content: { notesHidden: true } },
      { id: 'theirs', type: 'note', content: { ownerId: 'other' } },
    ];

    const move: StateActions = {
      op: 'patch',
      data: {
        id: 'theirs',
        type: 'note',
        content: { position: { x: 1, y: 1 } },
      },
    };

    effects.batchNodeActions$.subscribe();
    actions$.next(
      BoardActions.batchNodeActions({
        history: false,
        actions: [
          // an undo of a text edit made before the notes were hidden
          {
            op: 'patch',
            data: { id: 'theirs', type: 'note', content: { text: 'old' } },
          },
          move,
        ],
      }),
    );

    expect(applyActions).toHaveBeenCalledWith([move], false);
    expect(send).toHaveBeenCalledWith([move]);
    expect(notify).toHaveBeenCalledTimes(1);

    actions$.next(
      BoardActions.batchNodeActions({
        history: true,
        actions: [{ op: 'remove', data: { id: 'theirs', type: 'note' } }],
      }),
    );

    expect(send).toHaveBeenCalledTimes(1);
  });
});
