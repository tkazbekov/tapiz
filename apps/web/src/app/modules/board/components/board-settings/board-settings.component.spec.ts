import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { Store } from '@ngrx/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSettings, TuNode } from '@tapiz/board-commons';
import { BoardFacade } from '../../../../services/board-facade.service';
import { BoardSettingsComponent } from './board-settings.component';

describe('BoardSettingsComponent', () => {
  const settings = signal<TuNode<BoardSettings> | undefined>(undefined);
  let dispatch: ReturnType<typeof vi.fn>;

  const create = () => {
    const component = TestBed.runInInjectionContext(
      () => new BoardSettingsComponent(),
    );

    TestBed.tick();

    return component;
  };

  beforeEach(() => {
    settings.set(undefined);
    dispatch = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        // isAdmin
        {
          provide: Store,
          useValue: { dispatch, selectSignal: () => signal(true) },
        },
        { provide: BoardFacade, useValue: { settings } },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
      ],
    });
  });

  it('keeps hidden notes and anonymous mode apart', () => {
    const { form } = create();
    const { anonymousMode, notesHidden } = form.controls;

    notesHidden.setValue(true);

    expect(anonymousMode.disabled).toBe(true);
    expect(notesHidden.enabled).toBe(true);

    notesHidden.setValue(false);
    anonymousMode.setValue(true);

    expect(anonymousMode.enabled).toBe(true);
    expect(notesHidden.disabled).toBe(true);
  });

  it('locks anonymous mode on a board whose notes are hidden', () => {
    settings.set({
      id: 'settings-1',
      type: 'settings',
      content: { notesHidden: true },
    });

    const { form } = create();

    expect(form.controls.anonymousMode.disabled).toBe(true);
  });

  it('saves hidden notes as a settings patch', () => {
    settings.set({ id: 'settings-1', type: 'settings', content: {} });

    const component = create();

    component.form.controls.notesHidden.setValue(true);
    component.submit();

    expect(dispatch.mock.calls[0][0].actions).toEqual([
      expect.objectContaining({
        op: 'patch',
        data: expect.objectContaining({
          id: 'settings-1',
          content: expect.objectContaining({ notesHidden: true }),
        }),
      }),
    ]);
    expect(
      dispatch.mock.calls[0][0].actions[0].data.content,
    ).not.toHaveProperty('anonymousMode');
  });
});
