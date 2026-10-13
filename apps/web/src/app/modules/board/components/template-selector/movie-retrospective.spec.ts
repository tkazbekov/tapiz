import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { parseBoardTemplate, type TuNode } from '@tapiz/board-commons';
import { syncNodeBox } from '@tapiz/sync-node-box';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateSelectorComponent } from './template-selector.component';
import {
  boardNodes,
  dispatchedAdds,
  provideInsertMocks,
} from './template-insert.testing';

// apps/web/src/assets, resolved from this spec rather than the cwd
const assetDir = join(
  import.meta.dirname,
  '../../../../../assets/templates/movie-retrospective/',
);

describe('Movie Retrospective template', () => {
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatch = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideInsertMocks(dispatch),
      ],
    });
    TestBed.overrideComponent(TemplateSelectorComponent, {
      set: {
        template: '',
        templateUrl: undefined,
        styleUrl: undefined,
        styleUrls: [],
        imports: [],
      },
    });
  });

  const movie = () => {
    const template = TestBed.createComponent(
      TemplateSelectorComponent,
    ).componentInstance.elements.find(
      (it) => it.id === 'builtin:movie-retrospective',
    );

    if (!template) {
      throw new Error('builtin:movie-retrospective is not in the selector');
    }

    return template;
  };

  it('ships self-contained vector art and a real thumbnail', async () => {
    expect(existsSync(join(assetDir, 'cinema-v1.svg'))).toBe(true);

    const svg = readFileSync(join(assetDir, 'cinema-v1.svg'), 'utf8');

    expect(svg).toContain('viewBox="0 0 3600 2800"');
    expect(svg).not.toMatch(
      /<(script|foreignObject|image)\b|(?:href|src)=["']https?:|url\(https?:/i,
    );

    const thumbnail = readFileSync(join(assetDir, 'thumbnail-v1.webp'));

    expect(thumbnail.subarray(0, 4).toString()).toBe('RIFF');
    expect(thumbnail.subarray(8, 12).toString()).toBe('WEBP');
    expect(await sharp(thumbnail).metadata()).toMatchObject({
      width: 720,
      height: 560,
      format: 'webp',
    });
  });

  it('is first in the selector with its own thumbnail, at the art ratio', async () => {
    const template = movie();

    expect(
      TestBed.createComponent(TemplateSelectorComponent).componentInstance
        .elements[0].id,
    ).toBe('builtin:movie-retrospective');
    expect(template).toMatchObject({
      name: 'Movie Retrospective',
      image: 'assets/templates/movie-retrospective/thumbnail-v1.webp',
      width: 360,
      height: 280,
    });

    const data = await template.load();

    expect(parseBoardTemplate(data).ok).toBe(true);
    expect(data.size.width / data.size.height).toBeCloseTo(360 / 280);

    // every vector url of the template is one of the shipped files
    data.nodes
      .filter((node) => node.type === 'vector')
      .forEach((node) => {
        const url = String(node.content['url']);

        expect(url).toMatch(/^assets\/templates\/movie-retrospective\//);
        expect(
          existsSync(join(assetDir, url.split('/').at(-1) ?? '')),
          url,
        ).toBe(true);
      });
  });

  it('inserts the art behind the panels and keeps the scene in order', async () => {
    const template = movie();
    const source = (await template.load()).nodes;
    const fixture = TestBed.createComponent(TemplateSelectorComponent);

    await fixture.componentInstance.create(template);

    const adds = dispatchedAdds(dispatch);
    const board = syncNodeBox();

    board.update(() => boardNodes);

    const painted: TuNode[] = board.actions(adds);
    const inserted = new Set(adds.map((add) => add.data.id));
    const scene = painted.filter((node) => inserted.has(node.id));
    const at = (id: string) => painted.findIndex((node) => node.id === id);
    const of = (type: string) =>
      scene.filter((node) => node.type === type).map((node) => at(node.id));

    expect(scene).toHaveLength(source.length);
    // the art is under the whole scene
    expect(scene[0].type).toBe('vector');
    // the existing panel stays under it, the existing note above the panels
    expect(at('existing-panel')).toBeLessThan(at(scene[0].id));
    expect(at('existing-note')).toBeGreaterThan(Math.max(...of('panel')));
    // panels in their own order, every note and ticket text on top of them
    expect(
      scene
        .filter((node) => node.type === 'panel')
        .map((node) => (node.content as { position: { x: number } }).position),
    ).toEqual(
      adds
        .filter((add) => add.data.type === 'panel')
        .map(
          (add) => (add.data.content as { position: { x: number } }).position,
        ),
    );
    of('note').forEach((index) => {
      expect(index).toBeGreaterThan(Math.max(...of('panel')));
    });

    // apart from the panels the web groups together, source order is kept
    const withoutPanels = (types: string[]) =>
      types.filter((type) => type !== 'panel');

    expect(withoutPanels(scene.map((node) => node.type))).toEqual(
      withoutPanels(source.map((node) => node.type)),
    );
    expect(
      scene
        .filter((node) => node.type !== 'panel')
        .map((node) => (node.content as { text?: string }).text),
    ).toEqual(
      source
        .filter((node) => node.type !== 'panel')
        .map((node) => node.content['text']),
    );

    // with that order fixed, pair each non-panel scene node with its source
    // node: the art and the header texts stay under the new panels, every
    // ticket prompt, note and footer text is painted over all of them
    const firstPanel = source.findIndex((node) => node.type === 'panel');
    const sourceIndexes = source
      .map((node, index) => ({ type: node.type, index }))
      .filter((node) => node.type !== 'panel')
      .map((node) => node.index);
    const rest = scene.filter((node) => node.type !== 'panel');
    const below = rest.filter((_, i) => sourceIndexes[i] < firstPanel);
    const above = rest.filter((_, i) => sourceIndexes[i] > firstPanel);

    expect(below.map((node) => node.type)).toEqual([
      'vector',
      'text',
      'text',
      'text',
    ]);
    expect(above.filter((node) => node.type === 'text')).toHaveLength(17);
    below.forEach((node) => {
      expect(at(node.id)).toBeLessThan(Math.min(...of('panel')));
    });
    above.forEach((node) => {
      expect(at(node.id)).toBeGreaterThan(Math.max(...of('panel')));
    });
  });

  it('gives the starter notes to the inserting user', async () => {
    const template = movie();

    await TestBed.createComponent(
      TemplateSelectorComponent,
    ).componentInstance.create(template);

    const notes = dispatchedAdds(dispatch).filter(
      (add) => add.data.type === 'note',
    );

    expect(notes).toHaveLength(12);
    notes.forEach((note) => {
      expect(note.data.content).toMatchObject({
        ownerId: 'user-1',
        votes: [],
        emojis: [],
      });
    });
  });
});
