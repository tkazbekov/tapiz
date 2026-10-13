import {
  Input,
  NO_ERRORS_SCHEMA,
  Pipe,
  PipeTransform,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { LucideEyeClosed } from '@lucide/angular';
import { MatIconModule } from '@angular/material/icon';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, TuNode } from '@tapiz/board-commons';
import { BoardFacade } from '../../../../services/board-facade.service';
import { boardPageFeature } from '../../reducers/boardPage.reducer';
import { DrawingStore } from '../drawing';
import { NodesStore } from '../../services/nodes.store';
import { NodeStore } from '../../services/node.store';
import { VotesService } from '../../services/votes.service';
import { NoteComponent } from './note.component';
import template from './note.component.html?raw';

// JIT specs skip the compiler step that marks signal inputs, so it's done here
for (const name of ['node', 'pasted', 'focus']) {
  Input({ alias: name, required: true, isSignal: true } as Input)(
    NoteComponent.prototype,
    name,
  );
}

@Pipe({ name: 'safeHtml' })
class SafeHtmlStubPipe implements PipeTransform {
  transform(value: string) {
    return value;
  }
}

describe('NoteComponent', () => {
  const notesHidden = signal(false);

  const note = (ownerId: string): TuNode<Note> => ({
    id: 'note-1',
    type: 'note',
    content: {
      text: '<p>secret</p>',
      ownerId,
      position: { x: 0, y: 0 },
      layer: 0,
      width: 300,
      height: 300,
      votes: [],
      emojis: [{ unicode: '🎉', position: { x: 0, y: 0 } }],
      drawing: [],
    },
  });

  const render = (ownerId: string) => {
    const fixture = TestBed.createComponent(NoteComponent);

    fixture.componentRef.setInput('node', note(ownerId));
    fixture.componentRef.setInput('pasted', true);
    fixture.componentRef.setInput('focus', false);
    fixture.detectChanges();

    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(() => {
    notesHidden.set(false);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: Store,
          useValue: {
            dispatch: vi.fn(),
            selectSignal: (selector: unknown) =>
              signal(selector === boardPageFeature.selectUserId ? 'me' : null),
          },
        },
        {
          provide: BoardFacade,
          useValue: {
            notesHidden,
            settings: signal(undefined),
            users: signal([]),
            nodes: signal([]),
          },
        },
        { provide: DrawingStore, useValue: { drawing: signal(false) } },
        { provide: NodesStore, useValue: { setFocusNode: vi.fn() } },
        { provide: VotesService, useValue: { vote: vi.fn() } },
        NodeStore,
      ],
    });

    // the editor, toolbar and node space aren't part of what's checked here
    TestBed.overrideComponent(NoteComponent, {
      set: {
        // the specs run without the Angular plugin that loads resource files
        template,
        templateUrl: undefined,
        styleUrls: [],
        imports: [LucideEyeClosed, MatIconModule, SafeHtmlStubPipe],
        schemas: [NO_ERRORS_SCHEMA],
      },
    });
  });

  it('shows the text, emojis and drawing of a note', () => {
    const element = render('other');

    expect(element.querySelector('.rich-text')?.textContent).toBe('secret');
    expect(element.querySelector('.emoji')).not.toBeNull();
    expect(element.querySelector('canvas')).not.toBeNull();
    expect(element.querySelector('.hidden-card')).toBeNull();
  });

  it('shows a blank card for someone else’s note while notes are hidden', () => {
    notesHidden.set(true);

    const element = render('other');

    expect(element.querySelector('.hidden-card')?.textContent).toContain(
      'Hidden until reveal',
    );
    expect(element.querySelector('.rich-text')).toBeNull();
    expect(element.querySelector('.emoji')).toBeNull();
    expect(element.querySelector('canvas')).toBeNull();
    expect(element.classList).toContain('masked');
  });

  it('keeps showing your own note while notes are hidden', () => {
    notesHidden.set(true);

    const element = render('me');

    expect(element.querySelector('.rich-text')).not.toBeNull();
    expect(element.querySelector('.hidden-card')).toBeNull();
  });
});
