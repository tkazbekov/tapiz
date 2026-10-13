import { parseBoardTemplate } from '../template-format.js';
import { boundsOfNodes } from '../geometry.js';
import { BUILTIN_TEMPLATES, findBuiltinTemplate } from './index.js';
import { nodes as movieNodes } from './movie-retrospective.js';

describe('BUILTIN_TEMPLATES', () => {
  it('has the five built-ins in selector order', () => {
    expect(BUILTIN_TEMPLATES.map((template) => template.id)).toEqual([
      'builtin:movie-retrospective',
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

describe('Movie Retrospective built-in', () => {
  const load = async () => {
    const template = findBuiltinTemplate('builtin:movie-retrospective');

    expect(template?.name).toBe('Movie Retrospective');

    if (!template) {
      throw new Error('builtin:movie-retrospective is not registered');
    }

    const data = await template.load();
    const parsed = parseBoardTemplate(data);

    expect(parsed.ok).toBe(true);

    return data;
  };
  const textOf = (content: Record<string, unknown>) => String(content['text']);

  it('is the cinema backdrop, six ticket panels and twelve starter notes', async () => {
    const data = await load();
    const types = data.nodes.map((node) => node.type);

    expect(data.nodes).toHaveLength(39);
    expect(new Set(types)).toEqual(
      new Set(['vector', 'text', 'panel', 'note']),
    );
    // the art is first, so it is painted behind everything else
    expect(data.nodes[0]).toMatchObject({
      type: 'vector',
      content: {
        url: 'assets/templates/movie-retrospective/cinema-v1.svg',
        position: { x: 0, y: 0 },
        width: 3600,
        height: 2800,
        layer: 1,
      },
    });
    expect(data.size).toEqual({ width: 3600, height: 2800 });

    const panels = data.nodes.filter((node) => node.type === 'panel');

    expect(panels.map((node) => node.content.position)).toEqual([
      { x: 260, y: 610 },
      { x: 1390, y: 610 },
      { x: 2520, y: 610 },
      { x: 260, y: 1580 },
      { x: 1390, y: 1580 },
      { x: 2520, y: 1580 },
    ]);
    panels.forEach((node) => {
      expect(node.content).toMatchObject({
        backgroundColor: 'transparent',
        borderWidth: 0,
        layer: 1,
      });
    });

    const text = data.nodes
      .filter((node) => node.type === 'text')
      .map((node) => textOf(node.content))
      .join(' ');

    [
      'THE SPRINT PREMIERE',
      'OPENING SCENE',
      'BLOCKBUSTERS',
      'PLOT TWISTS',
      'BLOOPER REEL',
      'CAST &amp; CREW',
      'THE SEQUEL',
      'THE RUN OF SHOW',
    ].forEach((label) => expect(text).toContain(label));

    const notes = data.nodes.filter((node) => node.type === 'note');

    expect(notes).toHaveLength(12);
    expect(textOf(notes[0].content)).toContain(
      'Example title: The Sprint Strikes Back',
    );
    notes.forEach((note) => {
      expect(note.content).toMatchObject({
        layer: 0,
        width: 300,
        height: 300,
        ownerId: '',
        votes: [],
        emojis: [],
        drawing: [],
      });
    });
  });

  it('keeps every node inside the art, two notes per ticket below its prompt', async () => {
    const data = await load();
    const size = (node: (typeof data.nodes)[number]) => ({
      width: Number(node.content['width']),
      height: Number(node.content['height']),
    });

    data.nodes.forEach((node) => {
      const { x, y } = node.content.position;
      const { width, height } = size(node);

      expect([x, y, width, height].every(Number.isFinite)).toBe(true);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(3600);
      expect(y + height).toBeLessThanOrEqual(2800);
    });

    data.nodes
      .filter((node) => node.type === 'panel')
      .forEach((panel) => {
        const box = { ...panel.content.position, ...size(panel) };
        const inside = data.nodes.filter((node) => {
          const { x, y } = node.content.position;
          const { width, height } = size(node);

          return (
            node.type === 'note' &&
            x >= box.x &&
            y >= box.y &&
            x + width <= box.x + box.width &&
            y + height <= box.y + box.height
          );
        });

        expect(inside).toHaveLength(2);
        expect(inside[0].content.position.y).toBeGreaterThanOrEqual(
          box.y + 240,
        );
        expect(inside[0].content.position.x + 300).toBeLessThan(
          inside[1].content.position.x,
        );
      });
  });

  it('carries no board-specific state or broken encoding', async () => {
    const data = await load();

    expect(boundsOfNodes(movieNodes)).toEqual({
      x: 0,
      y: 0,
      width: 3600,
      height: 2800,
    });
    expect(movieNodes.every((node) => node.id === '')).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(
      /192\.168\.|\/api\/|boardId|textHidden|â|Ã/,
    );
  });
});
