import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fromLegacyTemplate, parseBoardTemplate } from '@tapiz/board-commons';
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

  it('has the four built-ins', () => {
    expect(builtIns().map((it) => it.title)).toEqual([
      'Stop, Start, Continue',
      'Sailboat',
      'Mad, Sad, Glad',
      'Starfish',
    ]);
  });

  it('parses every built-in as template data', async () => {
    for (const template of builtIns()) {
      const nodes = (await template.load()).getTemplate();
      const parsed = parseBoardTemplate(fromLegacyTemplate(nodes));

      expect(parsed.ok, template.title).toBe(true);
    }
  });

  it('inserts every built-in with its panels in their own order', async () => {
    for (const template of builtIns()) {
      dispatch.mockClear();

      const fixture = TestBed.createComponent(TemplateSelectorComponent);
      const selected = vi.fn();
      fixture.componentInstance.selected.subscribe(selected);

      const source = (await template.load()).getTemplate();

      await fixture.componentInstance.create(template);

      const adds = dispatchedAdds(dispatch);
      const panels = adds.filter((add) => add.data.type === 'panel');
      const positions = panels.map((add) => add.position ?? -1);

      expect(dispatch, template.title).toHaveBeenCalledTimes(1);
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
          expect(position, template.title).toBeGreaterThan(
            positions[index - 1],
          );
        }
      });
      expect(selected).toHaveBeenCalledTimes(1);
    }
  });
});
