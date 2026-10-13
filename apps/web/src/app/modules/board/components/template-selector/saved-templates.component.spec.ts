import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardTemplateData, templatePreview } from '@tapiz/board-commons';
import {
  TemplateApiService,
  TemplateSummary,
} from '../../../../services/template-api.service';
import { NotificationService } from '../../../../shared/notification/notification.service';
import { SavedTemplatesComponent } from './saved-templates.component';
import {
  dispatchedAdds,
  lanesTemplate,
  provideInsertMocks,
} from './template-insert.testing';
import { templateThumbnail } from './template-thumbnail';

const thumbnailOf = (data: BoardTemplateData) =>
  templateThumbnail(templatePreview(data) ?? [], data.size);

const summary = (
  id: string,
  name: string,
  scope: TemplateSummary['scope'],
  canEdit = true,
): TemplateSummary => ({
  id,
  name,
  description: null,
  scope,
  nodeCount: lanesTemplate.nodes.length,
  width: lanesTemplate.size.width,
  height: lanesTemplate.size.height,
  createdBy: 'user-1',
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  canEdit,
  preview: templatePreview(lanesTemplate),
});

const templates = [
  summary(
    't-team',
    'Team lanes',
    {
      kind: 'team',
      teamId: 'team-1',
      teamName: 'Design',
    },
    false,
  ),
  summary('t-mine', 'My lanes', { kind: 'personal' }),
];

describe('SavedTemplatesComponent', () => {
  let dispatch: ReturnType<typeof vi.fn>;
  let api: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    changed: Subject<void>;
  };
  let notify: ReturnType<typeof vi.fn>;
  let confirmed: boolean;

  beforeEach(() => {
    dispatch = vi.fn();
    notify = vi.fn();
    confirmed = true;
    api = {
      list: vi.fn(() => of(templates)),
      get: vi.fn((id: string) =>
        of({ ...templates.find((it) => it.id === id), data: lanesTemplate }),
      ),
      remove: vi.fn(() => of({ success: true })),
      changed: new Subject<void>(),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideInsertMocks(dispatch),
        { provide: TemplateApiService, useValue: api },
        { provide: NotificationService, useValue: { open: notify } },
        {
          provide: MatDialog,
          useValue: {
            open: vi.fn(() => ({ afterClosed: () => of(confirmed) })),
          },
        },
      ],
    });

    // the specs run without the Angular plugin that loads resource files
    TestBed.overrideComponent(SavedTemplatesComponent, {
      set: { styleUrl: undefined, styleUrls: [] },
    });
  });

  const render = async () => {
    const fixture = TestBed.createComponent(SavedTemplatesComponent);
    await fixture.whenStable();

    return fixture;
  };

  it('groups my templates first, then each team', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(
      [...el.querySelectorAll('h3')].map((it) => it.textContent?.trim()),
    ).toEqual(['My templates', 'Design']);
    expect(
      [...el.querySelectorAll('.insert p')].map((it) => it.textContent?.trim()),
    ).toEqual(['My lanes', 'Team lanes']);
    // only the template the user can edit has a delete button
    expect(el.querySelectorAll('.delete')).toHaveLength(1);
  });

  it('draws the thumbnails from the listed previews, without a get per card', async () => {
    const fixture = await render();
    const svgs = (fixture.nativeElement as HTMLElement).querySelectorAll('svg');

    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('viewBox')).toBe('0 0 1400 1000');
    expect(svgs[0].querySelectorAll('rect.panel')).toHaveLength(3);
    expect(svgs[0].querySelectorAll('rect.note')).toHaveLength(1);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('inserts a template as one batch and emits selected', async () => {
    const fixture = await render();
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);

    await fixture.componentInstance.insert(templates[1]);

    expect(api.get).toHaveBeenLastCalledWith('t-mine');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const adds = dispatchedAdds(dispatch);

    expect(new Set(adds.map((add) => add.data.id)).size).toBe(4);
    expect(
      adds.filter((add) => add.data.type === 'panel').map((it) => it.position),
    ).toEqual([2, 3, 4]);
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it('shows an insert error without dispatching', async () => {
    const fixture = await render();
    api.get.mockReturnValueOnce(throwError(() => new Error('Not found')));

    await fixture.componentInstance.insert(templates[1]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Not found', type: 'error' }),
    );
  });

  it('says it is loading until the list arrives', async () => {
    const list = new Subject<TemplateSummary[]>();
    api.list.mockReturnValueOnce(list);
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.hint')?.textContent).toContain('Loading');

    list.next(templates);
    list.complete();
    await fixture.whenStable();

    expect(el.querySelector('.hint')).toBeNull();
  });

  it('marks a template without a preview', async () => {
    api.list.mockReturnValueOnce(
      of([
        { ...templates[0], preview: null },
        { ...templates[1], preview: [] },
        summary('t-other', 'Other lanes', { kind: 'personal' }),
      ]),
    );
    const fixture = await render();
    const cards = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.card',
    );

    // my templates first: the empty preview, then a drawn one; the team's
    // null preview last
    expect(cards[0].querySelector('.no-preview')?.textContent).toBe(
      'No preview',
    );
    expect(cards[1].querySelector('svg')).not.toBeNull();
    expect(cards[2].querySelector('.no-preview')?.textContent).toBe(
      'No preview',
    );
  });

  it('lists again after a template is saved', async () => {
    const fixture = await render();
    const saved = summary('t-new', 'New lanes', { kind: 'personal' });
    api.list.mockReturnValueOnce(of([saved, ...templates]));

    api.changed.next();
    await fixture.whenStable();

    expect(
      [
        ...(fixture.nativeElement as HTMLElement).querySelectorAll('.insert p'),
      ].map((it) => it.textContent?.trim()),
    ).toEqual(['New lanes', 'My lanes', 'Team lanes']);
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('svg'),
    ).toHaveLength(3);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('blocks inserts while another one loads', async () => {
    const response = new Subject<unknown>();
    const fixture = await render();
    api.get.mockReturnValueOnce(response);

    const first = fixture.componentInstance.insert(templates[1]);
    await fixture.whenStable();

    expect(fixture.componentInstance.busy()).toBe(true);
    expect(
      (
        (fixture.nativeElement as HTMLElement).querySelector(
          '.insert',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await fixture.componentInstance.insert(templates[0]);
    response.next({ ...templates[1], data: lanesTemplate });
    response.complete();
    await first;

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.busy()).toBe(false);
  });

  it('deletes after confirming', async () => {
    const fixture = await render();

    fixture.componentInstance.remove(templates[1]);
    await fixture.whenStable();

    expect(api.remove).toHaveBeenCalledWith('t-mine');
    expect(fixture.componentInstance.templates().map((it) => it.id)).toEqual([
      't-team',
    ]);
  });

  it('keeps the template when the delete is cancelled', async () => {
    const fixture = await render();
    confirmed = false;

    fixture.componentInstance.remove(templates[1]);

    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe('templateThumbnail', () => {
  it('outlines panels, fills notes and draws text as bars', () => {
    const thumbnail = thumbnailOf({
      version: 1,
      size: { width: 3000, height: 1800 },
      nodes: [
        ...lanesTemplate.nodes,
        {
          ref: 'title',
          type: 'text',
          content: {
            position: { x: 0, y: 0 },
            layer: 1,
            width: 1000,
            height: 400,
            text: 'Title',
          },
        },
      ],
    });

    expect(thumbnail.shapes.map((shape) => shape.kind)).toEqual([
      'panel',
      'panel',
      'panel',
      'note',
      'text',
    ]);
    expect(thumbnail.shapes[3]).toMatchObject({ fill: '#fbb980' });
    // one 6px line of a 300px wide card
    expect(thumbnail.shapes[4]).toMatchObject({ width: 1000, height: 60 });
  });

  it('draws an attached arrow between its nodes, not its stored points', () => {
    const box = (ref: string, x: number) => ({
      ref,
      type: 'note' as const,
      content: {
        position: { x, y: 500 },
        layer: 0,
        width: 100,
        height: 100,
        text: '',
        votes: [],
        emojis: [],
        drawing: [],
        ownerId: '',
      },
    });
    const thumbnail = thumbnailOf({
      version: 1,
      size: { width: 1000, height: 1000 },
      nodes: [
        box('a', 500),
        box('b', 900),
        {
          ref: 'arrow',
          type: 'arrow',
          content: {
            position: { x: 0, y: 0 },
            layer: 0,
            start: { x: 0, y: 0 },
            end: { x: 100, y: 0 },
            startAttachment: { nodeId: 'a', offset: { x: 100, y: 50 } },
            endAttachment: { nodeId: 'b', offset: { x: 0, y: 50 } },
          },
        },
      ],
    });

    expect(thumbnail.shapes[2]).toEqual({
      kind: 'line',
      x1: 600,
      y1: 550,
      x2: 900,
      y2: 550,
    });
  });

  it('keeps the stored points of a free arrow', () => {
    const thumbnail = thumbnailOf({
      version: 1,
      size: { width: 500, height: 500 },
      nodes: [
        {
          ref: 'arrow',
          type: 'arrow',
          content: {
            position: { x: 10, y: 20 },
            layer: 0,
            start: { x: 0, y: 0 },
            end: { x: 100, y: 40 },
          },
        },
      ],
    });

    expect(thumbnail.shapes[0]).toMatchObject({
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 60,
    });
  });
});
