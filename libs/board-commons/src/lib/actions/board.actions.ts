import { props, createAction } from '@ngrx/store';
import { BoardCommonActions } from '../board-common-actions';
import { BachStateActions, StateActions, TuNode } from '../models/node.model';

export const BoardActions = {
  broadcast: createAction(
    BoardCommonActions.broadcast,
    props<{ data: unknown }>(),
  ),
  setBoardName: createAction(
    BoardCommonActions.setBoardName,
    props<{ name: string }>(),
  ),
  batchNodeActions: createAction(
    BoardCommonActions.batchNodeActions,
    props<BachStateActions>(),
  ),
  setState: createAction(
    BoardCommonActions.setState,
    props<{ data: TuNode[] }>(),
  ),
  // the whole board again after notes are hidden or revealed; unlike
  // setState it doesn't restore the initial view
  resyncState: createAction(
    BoardCommonActions.resyncState,
    props<{ data: TuNode[] }>(),
  ),
  stateAction: createAction(
    BoardCommonActions.stateAction,
    props<{ data: StateActions[] }>(),
  ),
};
