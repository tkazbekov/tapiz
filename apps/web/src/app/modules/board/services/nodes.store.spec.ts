import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NodesStore } from './nodes.store';
import { vi, describe, beforeEach, it, expect } from 'vitest';
import { Store } from '@ngrx/store';
import { BoardFacade } from '../../../services/board-facade.service';
import { NodesActions } from './nodes-actions';
import { isNoteMaskedFor, type Note, type TuNode } from '@tapiz/board-commons';

vi.mock('@tapiz/cdk/utils/overlapping-nodes', () => ({
  overlappingNodes: (_rect: unknown, nodes: unknown[]) => nodes,
}));

vi.mock('../../../shared/node-size', () => ({
  getNodeSize: () => ({ width: 100, height: 100 }),
}));

describe('NodesStore (Layer Manipulation)', () => {
  let nodesStore: NodesStore;
  let storeDispatch: ReturnType<typeof vi.fn>;
  let allNodes: TestNode[];
  let notesHidden: boolean;

  interface TestNode {
    id: string;
    type: string;
    content: { position: { x: number; y: number }; votes: unknown[] } & Record<
      string,
      unknown
    >;
  }

  const makeNode = (id: string): TestNode => ({
    id,
    type: 'note',
    content: {
      position: { x: 0, y: 0 },
      votes: [],
    },
  });

  beforeEach(() => {
    allNodes = [];
    notesHidden = false;
    storeDispatch = vi.fn();

    const mockStore = {
      dispatch: storeDispatch,
      // isAdmin
      selectSignal: () => () => false,
    };

    const settings = () => ({
      id: 'settings',
      type: 'settings',
      content: { notesHidden },
    });

    const mockBoardFacade = {
      nodes: () => allNodes,
      getNode: (id: string) => allNodes.find((it) => it.id === id),
      settings,
      notesHidden: () => notesHidden,
      isMasked: (node: TuNode) =>
        isNoteMaskedFor(node, settings().content, 'me'),
      currentUser: () => ({ id: 'me' }),
    };

    const mockNodesActions = {
      bulkPatch: vi.fn((patches: any[]) => {
        return patches.map((p: any) => ({
          data: { id: p.node.id, type: p.node.type, content: p.node.content },
          op: 'patch' as const,
          position: p.options.position,
        }));
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        NodesStore,
        { provide: Store, useValue: mockStore },
        { provide: BoardFacade, useValue: mockBoardFacade },
        { provide: NodesActions, useValue: mockNodesActions },
      ],
    });

    nodesStore = TestBed.inject(NodesStore);
  });

  describe('bringForward', () => {
    it('should move each selected node ahead of next unselected node', () => {
      allNodes = [makeNode('1'), makeNode('2'), makeNode('3'), makeNode('4')];
      const selectedNodes = [allNodes[1], allNodes[2]]; // nodes 2 & 3 selected

      storeDispatch.mockClear();
      nodesStore.bringForward(selectedNodes);

      expect(storeDispatch).toHaveBeenCalledTimes(2);

      const firstAction = storeDispatch.mock.calls[0][0];
      const secondAction = storeDispatch.mock.calls[1][0];

      expect(firstAction.actions[0].data.id).toBe('2');
      expect(firstAction.actions[0].position).toBe(3);
      expect(secondAction.actions[0].data.id).toBe('3');
      expect(secondAction.actions[0].position).toBe(3);
    });
  });

  describe('sendBackward', () => {
    it('should move each selected node behind previous unselected node', () => {
      allNodes = [makeNode('1'), makeNode('2'), makeNode('3'), makeNode('4')];
      const selectedNodes = [allNodes[1], allNodes[2]]; // nodes 2 & 3 selected

      storeDispatch.mockClear();
      nodesStore.sendBackward(selectedNodes);

      expect(storeDispatch).toHaveBeenCalledTimes(2);

      const firstAction = storeDispatch.mock.calls[0][0];
      const secondAction = storeDispatch.mock.calls[1][0];

      expect(firstAction.actions[0].data.id).toBe('3');
      expect(firstAction.actions[0].position).toBe(0);
      expect(secondAction.actions[0].data.id).toBe('2');
      expect(secondAction.actions[0].position).toBe(0);
    });
  });

  describe('while notes are hidden', () => {
    const note = (id: string, ownerId: string) =>
      ({
        id,
        type: 'note',
        content: { ownerId, position: { x: 0, y: 0 }, votes: [] },
      }) as unknown as TuNode<Note> & TestNode;

    it('lets nobody make a note public', () => {
      const mine = note('1', 'me');

      expect(nodesStore.canMakeNotePublic(mine)).toBe(true);

      notesHidden = true;

      expect(nodesStore.canMakeNotePublic(mine)).toBe(false);
    });

    it('only deletes the notes that can be removed', () => {
      allNodes = [note('mine', 'me'), note('theirs', 'other')];
      notesHidden = true;

      nodesStore.deleteNodes([
        { id: 'mine', type: 'note' },
        { id: 'theirs', type: 'note' },
      ]);

      expect(storeDispatch).toHaveBeenCalledTimes(1);
      expect(
        storeDispatch.mock.calls[0][0].actions.map(
          (it: { data: { id: string } }) => it.data.id,
        ),
      ).toEqual(['mine']);

      storeDispatch.mockClear();
      nodesStore.deleteNodes([{ id: 'theirs', type: 'note' }]);

      expect(storeDispatch).not.toHaveBeenCalled();
    });

    it('does not copy hidden notes', () => {
      const writeText = vi.fn();

      vi.stubGlobal('navigator', { clipboard: { writeText } });
      notesHidden = true;

      nodesStore.copyNodes([note('mine', 'me'), note('theirs', 'other')]);

      expect(JSON.parse(writeText.mock.calls[0][0])).toEqual([
        note('mine', 'me'),
      ]);

      vi.unstubAllGlobals();
    });
  });
});
