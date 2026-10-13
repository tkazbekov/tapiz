import { parseBoardTemplate } from '../template-format.js';
import { BUILTIN_TEMPLATES, findBuiltinTemplate } from './index.js';

describe('BUILTIN_TEMPLATES', () => {
  it('has the four built-ins in selector order', () => {
    expect(BUILTIN_TEMPLATES.map((template) => template.id)).toEqual([
      'builtin:stop-start-continue',
      'builtin:sailboat',
      'builtin:mad-sad-glad',
      'builtin:starfish',
    ]);
  });

  it('has unique prefixed ids that match the slug', () => {
    const ids = BUILTIN_TEMPLATES.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
    BUILTIN_TEMPLATES.forEach((template) => {
      expect(template.id).toBe(`builtin:${template.slug}`);
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    });
  });

  it('loads every built-in as valid template data', async () => {
    for (const template of BUILTIN_TEMPLATES) {
      const data = await template.load();
      const parsed = parseBoardTemplate(data);

      expect(parsed.ok, template.id).toBe(true);
      expect(data.nodes.length, template.id).toBeGreaterThan(0);
      expect(new Set(data.nodes.map((node) => node.ref)).size).toBe(
        data.nodes.length,
      );
    }
  });
});

describe('findBuiltinTemplate', () => {
  it('finds a built-in by id', () => {
    expect(findBuiltinTemplate('builtin:starfish')?.name).toBe('Starfish');
  });

  it('returns undefined for unknown ids', () => {
    expect(findBuiltinTemplate('builtin:nope')).toBeUndefined();
    expect(findBuiltinTemplate('starfish')).toBeUndefined();
  });
});
