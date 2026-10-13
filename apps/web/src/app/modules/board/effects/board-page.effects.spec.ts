import { TestBed } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';
import { Action } from '@ngrx/store';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { catchError, take, timeout } from 'rxjs/operators';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ActivatedRoute } from '@angular/router';
import { BoardFacade } from '../../../services/board-facade.service';
import { BoardApiService } from '../../../services/board-api.service';
import { BoardPageActions } from '../actions/board-page.actions';
import { BoardActions } from '../actions/board.actions';
import { boardPageFeature } from '../reducers/boardPage.reducer';
import { BoardPageEffects } from './board-page.effects';
import { ConfigService } from '../../../services/config.service';

describe('BoardPageEffects', () => {
  let actions$: Subject<Action>;
  let effects: BoardPageEffects;
  let store: MockStore;
  let getBoardMentions: ReturnType<typeof vi.fn>;
  let mentionBoardUser: ReturnType<typeof vi.fn>;
  const config = { DEMO: false };

  beforeEach(() => {
    config.DEMO = false;
    getBoardMentions = vi.fn(() => of([]));
    mentionBoardUser = vi.fn(() => of({ success: true }));
    actions$ = new Subject<Action>();

    TestBed.configureTestingModule({
      providers: [
        BoardPageEffects,
        provideMockActions(() => actions$),
        provideMockStore(),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParams: {},
            },
          },
        },
        {
          provide: BoardFacade,
          useValue: {
            nodes: () => [],
            usersNodes: () => [],
          },
        },
        {
          provide: BoardApiService,
          useValue: { getBoardMentions, mentionBoardUser },
        },
        {
          provide: ConfigService,
          useValue: { config },
        },
      ],
    });

    effects = TestBed.inject(BoardPageEffects);
    store = TestBed.inject(MockStore);
  });

  it('keeps a pinned popup open when navigating to a node', async () => {
    store.overrideSelector(boardPageFeature.selectPopupPinned, true);
    store.refreshState();

    const result = firstValueFrom(
      effects.goToNoteResetPopup$.pipe(
        take(1),
        timeout({ first: 20 }),
        catchError(() => of(null)),
      ),
    );

    actions$.next(BoardPageActions.goToNode({ nodeId: 'note-1' }));

    await expect(result).resolves.toBeNull();
  });

  it('closes an unpinned popup when navigating to a node', async () => {
    store.overrideSelector(boardPageFeature.selectPopupPinned, false);
    store.refreshState();

    const result = firstValueFrom(effects.goToNoteResetPopup$.pipe(take(1)));

    actions$.next(BoardPageActions.goToNode({ nodeId: 'note-1' }));

    await expect(result).resolves.toEqual(
      BoardPageActions.setPopupOpen({ popup: '' }),
    );
  });

  it('restores the initial view on the first setState, not on a resync', () => {
    store.overrideSelector(boardPageFeature.selectBoardId, 'board-1');
    store.refreshState();

    const emitted: Action[] = [];
    const subscription = effects.restoreUserView$.subscribe((action) =>
      emitted.push(action),
    );

    actions$.next(
      BoardPageActions.fetchBoardSuccess({
        name: 'Board',
        isAdmin: true,
        isPublic: false,
        privateId: '',
        teamName: null,
        teamId: null,
      }),
    );
    // hiding or revealing notes resends the board, the view stays put
    actions$.next(BoardActions.resyncState({ data: [] }));

    expect(emitted).toEqual([]);

    actions$.next(BoardActions.setState({ data: [] }));

    expect(emitted).toEqual([
      BoardPageActions.setUserView({ zoom: 1, position: { x: 0, y: 0 } }),
    ]);

    subscription.unsubscribe();
  });

  it('keeps sending mentions after one is refused', async () => {
    store.overrideSelector(boardPageFeature.selectBoardId, 'board-1');
    store.overrideSelector(boardPageFeature.selectUserId, 'user-1');
    store.refreshState();
    mentionBoardUser.mockReturnValueOnce(
      throwError(() => new Error('User is not a member of this board.')),
    );

    const errors: unknown[] = [];
    const subscription = effects.mentionUser$.subscribe({
      error: (error) => errors.push(error),
    });

    actions$.next(BoardPageActions.mentionUser({ userId: 'user-2' }));
    actions$.next(BoardPageActions.mentionUser({ userId: 'user-3' }));

    expect(errors).toEqual([]);
    expect(mentionBoardUser).toHaveBeenCalledTimes(2);
    expect(mentionBoardUser).toHaveBeenLastCalledWith(
      'board-1',
      'user-3',
      undefined,
    );

    subscription.unsubscribe();
  });

  it('does not fetch authenticated mentions in Demo', async () => {
    config.DEMO = true;
    store.overrideSelector(boardPageFeature.selectBoardId, 'demo');
    store.refreshState();

    const result = firstValueFrom(
      effects.fetchMentions$.pipe(
        take(1),
        timeout({ first: 20 }),
        catchError(() => of(null)),
      ),
    );

    actions$.next(
      BoardPageActions.fetchBoardSuccess({
        name: 'Demo',
        isAdmin: true,
        isPublic: false,
        privateId: '',
        teamName: null,
        teamId: null,
      }),
    );

    await expect(result).resolves.toBeNull();
    expect(getBoardMentions).not.toHaveBeenCalled();
  });
});
