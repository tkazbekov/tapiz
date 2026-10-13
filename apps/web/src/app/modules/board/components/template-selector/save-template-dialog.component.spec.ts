import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateTemplateResult,
  TemplateApiService,
} from '../../../../services/template-api.service';
import { NotificationService } from '../../../../shared/notification/notification.service';
import {
  SaveTemplateDialogComponent,
  SaveTemplateDialogData,
  saveTemplateMessage,
} from './save-template-dialog.component';

const result = (
  dropped: number,
  levels: ('warning' | 'error')[],
): CreateTemplateResult => ({
  template: {
    id: 't-1',
    name: 'Lanes',
    description: null,
    scope: { kind: 'personal' },
    nodeCount: 3,
    width: 100,
    height: 100,
    createdBy: 'user-1',
    createdAt: '',
    updatedAt: '',
    canEdit: true,
  },
  dropped: Array.from({ length: dropped }, (_, index) => ({
    id: `d${index}`,
    type: 'note',
    reason: 'masked_note' as const,
  })),
  detachedArrows: [],
  lint: levels.map((level) => ({
    level,
    code: 'note_overlap' as const,
    nodeIds: [],
    message: '',
  })),
});

describe('SaveTemplateDialogComponent', () => {
  let createFromBoard: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let dialogRef: { close: ReturnType<typeof vi.fn>; disableClose?: boolean };

  const setup = (
    team: SaveTemplateDialogData['team'],
    nodeIds = ['a', 'b'],
  ) => {
    createFromBoard = vi.fn(() => of(result(2, ['warning', 'error'])));
    close = vi.fn();
    notify = vi.fn();
    dialogRef = { close };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { boardId: 'board-1', nodeIds, team },
        },
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: TemplateApiService, useValue: { createFromBoard } },
        { provide: NotificationService, useValue: { open: notify } },
      ],
    });

    // the specs run without the Angular plugin that loads resource files
    TestBed.overrideComponent(SaveTemplateDialogComponent, {
      set: { styleUrl: undefined, styleUrls: [] },
    });

    const fixture = TestBed.createComponent(SaveTemplateDialogComponent);
    fixture.detectChanges();

    return fixture;
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('saves a personal template from the selected nodes', () => {
    const fixture = setup(null);
    const component = fixture.componentInstance;

    component.form.setValue({
      name: '  Lanes ',
      description: '  ',
      scope: 'personal',
    });
    component.submit();

    expect(createFromBoard).toHaveBeenCalledWith({
      boardId: 'board-1',
      nodeIds: ['a', 'b'],
      name: 'Lanes',
      scope: 'personal',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Saved "Lanes" (2 nodes left out, 1 layout warning)',
        type: 'info',
      }),
    );
  });

  it('only offers the team when the board has one', () => {
    const el = setup(null).nativeElement as HTMLElement;

    expect(el.querySelector('mat-select')).toBeNull();

    TestBed.resetTestingModule();

    const withTeam = setup({ id: 'team-1', name: 'Design' })
      .nativeElement as HTMLElement;

    expect(withTeam.querySelector('mat-select')).not.toBeNull();
  });

  it('saves for the board team', () => {
    const component = setup({ id: 'team-1', name: 'Design' }).componentInstance;

    component.form.setValue({
      name: 'Lanes',
      description: 'Three lanes',
      scope: 'team',
    });

    expect(component.payload()).toEqual({
      boardId: 'board-1',
      nodeIds: ['a', 'b'],
      name: 'Lanes',
      description: 'Three lanes',
      scope: 'team',
      teamId: 'team-1',
    });
  });

  it('needs a name', () => {
    const component = setup(null).componentInstance;

    component.form.setValue({
      name: '   ',
      description: '',
      scope: 'personal',
    });
    component.submit();

    expect(createFromBoard).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and shows the error', () => {
    const component = setup(null).componentInstance;
    createFromBoard.mockReturnValueOnce(
      throwError(() => new Error('Board not found')),
    );

    component.form.setValue({
      name: 'Lanes',
      description: '',
      scope: 'personal',
    });
    component.submit();

    expect(close).not.toHaveBeenCalled();
    expect(component.saving()).toBe(false);
    expect(dialogRef.disableClose).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Board not found', type: 'error' }),
    );
  });

  it('shows a generic error instead of a validation issue list', () => {
    const component = setup(null).componentInstance;
    createFromBoard.mockReturnValueOnce(
      throwError(
        () =>
          new Error('[\n  {\n    "origin": "array",\n    "code": "too_big"'),
      ),
    );

    component.form.setValue({
      name: 'Lanes',
      description: '',
      scope: 'personal',
    });
    component.submit();

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Could not save the template',
        type: 'error',
      }),
    );
  });

  it('cannot be closed while saving', () => {
    const fixture = setup(null);
    const component = fixture.componentInstance;
    const response = new Subject<CreateTemplateResult>();
    createFromBoard.mockReturnValueOnce(response);

    component.form.setValue({
      name: 'Lanes',
      description: '',
      scope: 'personal',
    });
    component.submit();
    fixture.detectChanges();

    expect(dialogRef.disableClose).toBe(true);
    expect(
      (
        (fixture.nativeElement as HTMLElement).querySelector(
          'button[type="button"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    response.next(result(0, []));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('refuses more nodes than a template can hold', () => {
    const nodeIds = Array.from({ length: 501 }, (_, index) => `n${index}`);
    const fixture = setup(null, nodeIds);
    const component = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;

    component.form.setValue({
      name: 'Lanes',
      description: '',
      scope: 'personal',
    });
    component.submit();
    fixture.detectChanges();

    expect(createFromBoard).not.toHaveBeenCalled();
    expect(el.querySelector('.error')?.textContent).toContain(
      'Select at most 500 nodes',
    );
    expect(
      (el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('saveTemplateMessage', () => {
  it('says nothing extra for a clean save', () => {
    expect(saveTemplateMessage(result(0, ['error']))).toBe('Saved "Lanes"');
  });

  it('counts dropped nodes and warnings', () => {
    expect(saveTemplateMessage(result(1, ['warning', 'warning']))).toBe(
      'Saved "Lanes" (1 node left out, 2 layout warnings)',
    );
  });
});
