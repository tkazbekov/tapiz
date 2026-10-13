import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TuNode } from '@tapiz/board-commons';
import { BoardFacade } from './board-facade.service';
import { CopyPasteService } from './copy-paste.service';

describe('CopyPasteService', () => {
  const notesHidden = signal(false);
  let dispatch: ReturnType<typeof vi.fn>;

  const copied: TuNode[] = [
    {
      id: 'n1',
      type: 'note',
      content: { ownerId: 'other', text: 'idea', position: { x: 0, y: 0 } },
    },
    {
      id: 'g1',
      type: 'group',
      content: { title: 'Group', position: { x: 0, y: 0 } },
    },
  ];

  const pastedContents = () =>
    dispatch.mock.calls[0][0].nodes.map((it: TuNode) => it.content);

  beforeEach(() => {
    notesHidden.set(false);
    dispatch = vi.fn();
    vi.stubGlobal('navigator', {
      clipboard: { readText: async () => JSON.stringify(copied) },
    });

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: Store,
          useValue: { dispatch, selectSignal: () => signal(0) },
        },
        {
          provide: BoardFacade,
          useValue: { notesHidden, userId: signal('me') },
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the owner of a pasted note', async () => {
    await TestBed.inject(CopyPasteService).pasteCurrentClipboard();

    expect(pastedContents()[0].ownerId).toBe('other');
  });

  it('pastes notes as your own while notes are hidden', async () => {
    notesHidden.set(true);

    await TestBed.inject(CopyPasteService).pasteCurrentClipboard();

    expect(pastedContents()[0]).toEqual(
      expect.objectContaining({ ownerId: 'me', text: 'idea' }),
    );
    expect(pastedContents()[1]).not.toHaveProperty('ownerId');
  });
});
