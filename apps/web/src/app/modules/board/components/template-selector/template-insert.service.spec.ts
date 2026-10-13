import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { parseBoardTemplate } from '@tapiz/board-commons';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardActions } from '../../actions/board.actions';
import { TemplateInsertService } from './template-insert.service';
import {
  dispatchedAdds,
  lanesTemplate,
  provideInsertMocks,
} from './template-insert.testing';

describe('TemplateInsertService', () => {
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatch = vi.fn();
    window.innerWidth = 1024;
    window.innerHeight = 768;

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideInsertMocks(dispatch),
      ],
    });
  });

  it('is valid template data', () => {
    expect(parseBoardTemplate(lanesTemplate)).toMatchObject({ ok: true });
  });

  it('dispatches one undoable batch with fresh ids', () => {
    TestBed.inject(TemplateInsertService).insert(lanesTemplate);

    expect(dispatch).toHaveBeenCalledTimes(1);

    const action = dispatch.mock.calls[0][0];
    const adds = dispatchedAdds(dispatch);
    const ids = adds.map((add) => add.data.id);

    expect(action.type).toBe(BoardActions.batchNodeActions.type);
    expect(action.history).toBe(true);
    expect(adds).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    ids.forEach((id) => {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('keeps the panels in order behind the existing notes', () => {
    TestBed.inject(TemplateInsertService).insert(lanesTemplate);

    const adds = dispatchedAdds(dispatch);
    const panelPositions = adds
      .filter((add) => add.data.type === 'panel')
      .map((add) => add.position);

    // after the existing panel (index 1), one after another
    expect(panelPositions).toEqual([2, 3, 4]);
    expect(adds.find((add) => add.data.type === 'note')?.position).toBe(
      undefined,
    );
  });

  it('centres the template in the viewport', () => {
    TestBed.inject(TemplateInsertService).insert(lanesTemplate);

    const adds = dispatchedAdds(dispatch);
    // centre: ((200 + 1024 / 2) / 0.5, (100 + (768 - 42) / 2) / 0.5)
    const origin = { x: 1424 - 700, y: 926 - 500 };

    expect(adds[0].data.content).toMatchObject({
      position: origin,
      layer: 1,
    });
    expect(adds[2].data.content).toMatchObject({
      position: { x: origin.x + 1000, y: origin.y },
    });
    expect(adds[3].data.content).toMatchObject({
      position: { x: origin.x + 50, y: origin.y + 100 },
      layer: 0,
      ownerId: 'user-1',
    });
  });

  it('runs one insert at a time and reports busy meanwhile', async () => {
    const service = TestBed.inject(TemplateInsertService);
    let resolve!: (data: typeof lanesTemplate) => void;
    const first = service.insertFrom(
      () => new Promise((done) => (resolve = done)),
    );

    expect(service.busy()).toBe(true);
    await expect(service.insertFrom(async () => lanesTemplate)).resolves.toBe(
      false,
    );

    resolve(lanesTemplate);

    await expect(first).resolves.toBe(true);
    expect(service.busy()).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('rethrows a load error and clears busy', async () => {
    const service = TestBed.inject(TemplateInsertService);

    await expect(
      service.insertFrom(() => Promise.reject(new Error('Not found'))),
    ).rejects.toThrow('Not found');
    expect(service.busy()).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
