import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Store } from '@ngrx/store';
import { TuNode } from '@tapiz/board-commons';
import {
  ContextMenuItem,
  ContextMenuStore,
} from '@tapiz/ui/context-menu/context-menu.store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appFeature } from '../../../../+state/app.reducer';
import { BoardFacade } from '../../../../services/board-facade.service';
import { CopyPasteService } from '../../../../services/copy-paste.service';
import { BoardComponent } from '../../board/board.component';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { NodesActions } from '../../services/nodes-actions';
import { NodesStore } from '../../services/nodes.store';
import { CommentsStore } from '../comments/comments.store';
import { SaveTemplateDialogComponent } from '../template-selector/save-template-dialog.component';
import { BoardContextMenuComponent } from './board-contextmenu.component';

const note = (id: string): TuNode => ({
  id,
  type: 'note',
  content: {
    position: { x: 0, y: 0 },
    layer: 0,
    text: '',
    votes: [],
    emojis: [],
    ownerId: 'someone',
  },
});

describe('BoardContextMenuComponent', () => {
  const isGuest = signal(false);
  const teamId = signal<string | null>(null);
  const focusNodes = signal<TuNode[]>([]);
  const masked = new Set<string>();
  let items: () => ContextMenuItem[];
  let openDialog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    isGuest.set(false);
    teamId.set(null);
    focusNodes.set([note('n1'), note('n2')]);
    masked.clear();
    openDialog = vi.fn();

    const selectors = new Map<unknown, unknown>([
      [appFeature.selectIsGuest, isGuest],
      [boardPageFeature.selectTeamId, teamId],
      [boardPageFeature.selectTeamName, signal('Design')],
      [boardPageFeature.selectBoardId, signal('board-1')],
      [boardPageFeature.selectIsAdmin, signal(false)],
      [boardPageFeature.selectBoardMode, signal(0)],
      [boardPageFeature.selectVoting, signal(false)],
      [boardPageFeature.selectPopupOpen, signal('')],
    ]);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: Store,
          useValue: {
            dispatch: vi.fn(),
            selectSignal: (selector: unknown) =>
              selectors.get(selector) ?? signal(null),
          },
        },
        {
          provide: ContextMenuStore,
          useValue: {
            config: (config: { items: () => ContextMenuItem[] }) => {
              items = config.items;
            },
          },
        },
        {
          provide: BoardFacade,
          useValue: {
            focusNodes,
            isMasked: (node: TuNode) => masked.has(node.id),
          },
        },
        {
          provide: BoardComponent,
          useValue: { el: { nativeElement: document.createElement('div') } },
        },
        { provide: MatDialog, useValue: { open: openDialog } },
        { provide: CopyPasteService, useValue: {} },
        { provide: NodesStore, useValue: {} },
        { provide: CommentsStore, useValue: {} },
        { provide: NodesActions, useValue: {} },
      ],
    });

    // the real MatDialogModule would shadow the mocked dialog
    TestBed.overrideComponent(BoardContextMenuComponent, {
      set: { imports: [] },
    });

    TestBed.createComponent(BoardContextMenuComponent).detectChanges();
  });

  const saveEntry = () =>
    items().find((item) => item.label === 'Save as template…');

  it('offers "Save as template…" to a signed-in member', () => {
    expect(saveEntry()).toMatchObject({ icon: 'bookmark_add' });
  });

  it('opens the dialog with the selection and the board team', () => {
    teamId.set('team-1');

    saveEntry()?.action(new MouseEvent('click'));

    expect(openDialog).toHaveBeenCalledWith(SaveTemplateDialogComponent, {
      data: {
        boardId: 'board-1',
        nodeIds: ['n1', 'n2'],
        team: { id: 'team-1', name: 'Design' },
      },
    });
  });

  it('hides it from guests', () => {
    isGuest.set(true);

    expect(saveEntry()).toBeUndefined();
  });

  it('hides it when every selected note is masked', () => {
    masked.add('n1').add('n2');

    expect(saveEntry()).toBeUndefined();
  });

  it('keeps it when only some notes are masked', () => {
    masked.add('n1');

    expect(saveEntry()).toBeDefined();
  });

  it('is not offered without a selection', () => {
    focusNodes.set([]);

    expect(saveEntry()).toBeUndefined();
  });
});
