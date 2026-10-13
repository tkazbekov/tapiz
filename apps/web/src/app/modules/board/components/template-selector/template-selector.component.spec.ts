import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BUILTIN_TEMPLATES, parseBoardTemplate } from '@tapiz/board-commons';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateSelectorComponent } from './template-selector.component';
import { dispatchedAdds, provideInsertMocks } from './template-insert.testing';

describe('TemplateSelectorComponent', () => {
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatch = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideInsertMocks(dispatch),
      ],
    });

    // only create() is checked; the specs don't load resource files
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

  const builtIns = () =>
    TestBed.createComponent(TemplateSelectorComponent).componentInstance
      .elements;

  it('has the four built-ins from board-commons, with previews', () => {
    expect(builtIns().map((it) => it.name)).toEqual([
      'Stop, Start, Continue',
      'Sailboat',
      'Mad, Sad, Glad',
      'Starfish',
    ]);
    expect(builtIns().map((it) => it.id)).toEqual(
      BUILTIN_TEMPLATES.map((it) => it.id),
    );
    builtIns().forEach((it) => {
      expect(it.image, it.name).toBe(`assets/templates/${it.slug}.webp`);
      expect(it.width, it.name).toBeGreaterThan(0);
      expect(it.height, it.name).toBeGreaterThan(0);
    });
  });

  it('parses every built-in as template data', async () => {
    for (const template of BUILTIN_TEMPLATES) {
      const parsed = parseBoardTemplate(await template.load());

      expect(parsed.ok, template.name).toBe(true);
    }
  });

  it('inserts every built-in with its panels in their own order', async () => {
    for (const template of builtIns()) {
      dispatch.mockClear();

      const fixture = TestBed.createComponent(TemplateSelectorComponent);
      const selected = vi.fn();
      fixture.componentInstance.selected.subscribe(selected);

      const source = (await template.load()).nodes;

      await fixture.componentInstance.create(template);

      const adds = dispatchedAdds(dispatch);
      const panels = adds.filter((add) => add.data.type === 'panel');
      const positions = panels.map((add) => add.position ?? -1);

      expect(dispatch, template.name).toHaveBeenCalledTimes(1);
      expect(adds.map((add) => add.data.type)).toEqual(
        source.map((node) => node.type),
      );
      expect(
        panels.map((add) => (add.data.content as { text?: string }).text),
      ).toEqual(
        source
          .filter((node) => node.type === 'panel')
          .map((node) => node.content['text']),
      );
      positions.forEach((position, index) => {
        if (index) {
          expect(position, template.name).toBeGreaterThan(positions[index - 1]);
        }
      });
      expect(selected).toHaveBeenCalledTimes(1);
    }
  });
});
