import {
  boardTemplateDataSchema,
  isAppTemplateAssetUrl,
  isPortableAssetUrl,
  parseBoardTemplate,
  TEMPLATE_LIMITS,
  type BoardTemplateData,
} from './template-format.js';

const panel = (ref = 'p') => ({
  ref,
  type: 'panel',
  content: {
    position: { x: 0, y: 0 },
    width: 700,
    height: 900,
    layer: 1,
    text: '<p>Lane</p>',
  },
});

const note = (ref = 'n') => ({
  ref,
  type: 'note',
  content: {
    position: { x: 40, y: 160 },
    width: 300,
    height: 300,
    layer: 0,
    text: '<p>Idea</p>',
    votes: [],
    emojis: [],
    drawing: [],
    ownerId: '',
    color: '#fdab61',
  },
});

const arrow = (ref: string, startRef?: string) => ({
  ref,
  type: 'arrow',
  content: {
    position: { x: 0, y: 0 },
    width: 100,
    height: 20,
    layer: 0,
    start: { x: 10, y: 10 },
    end: { x: 90, y: 10 },
    strokeStyle: 'solid',
    arrowType: 'sharp',
    ...(startRef
      ? { startAttachment: { nodeId: startRef, offset: { x: 0, y: 0 } } }
      : {}),
  },
});

const asset = (type: 'image' | 'vector', url: string) => ({
  ref: type,
  type,
  content: {
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    layer: 1,
    rotation: 0,
    url,
  },
});

const template = (nodes: unknown[]) => ({
  version: 1,
  size: { width: 700, height: 900 },
  nodes,
});

const messages = (raw: unknown) => {
  const result = parseBoardTemplate(raw);

  return result.ok ? [] : result.issues.map((issue) => issue.message);
};

describe('board template format', () => {
  it('accepts a valid template and returns the parsed data', () => {
    const result = parseBoardTemplate(
      template([
        panel(),
        note(),
        arrow('a', 'n'),
        asset('image', 'https://example.com/a.png'),
      ]),
    );

    expect(result.ok).toBe(true);
    expect((result as { data: BoardTemplateData }).data.nodes).toHaveLength(4);
  });

  it('strips keys the node validators do not know', () => {
    const raw = template([{ ...panel(), id: 'x', children: [] }]) as {
      nodes: { content: Record<string, unknown> }[];
    };

    raw.nodes[0].content['secret'] = 1;

    const result = parseBoardTemplate(raw);

    expect(result.ok && result.data.nodes[0]).toEqual(panel());
  });

  it('rejects other versions', () => {
    expect(messages({ ...template([panel()]), version: 2 })).toEqual([
      'unsupported_template_version',
    ]);
    expect(messages(null)).toEqual(['unsupported_template_version']);
  });

  it('requires a layer on every node, panels and groups included', () => {
    const noLayer = panel();

    delete (noLayer.content as Partial<typeof noLayer.content>).layer;

    expect(parseBoardTemplate(template([noLayer])).ok).toBe(false);
    expect(
      parseBoardTemplate(
        template([
          {
            ref: 'g',
            type: 'group',
            content: { position: { x: 0, y: 0 }, width: 10, height: 10 },
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseBoardTemplate(
        template([{ ...panel(), content: { ...panel().content, layer: 2 } }]),
      ).ok,
    ).toBe(false);
  });

  it('runs the real node validators', () => {
    const withoutVotes: Partial<ReturnType<typeof note>['content']> =
      note().content;

    delete withoutVotes.votes;

    expect(
      parseBoardTemplate(template([{ ...note(), content: withoutVotes }])).ok,
    ).toBe(false);
  });

  it('rejects unknown node types', () => {
    expect(
      parseBoardTemplate(
        template([
          {
            ref: 'x',
            type: 'poll',
            content: { position: { x: 0, y: 0 }, layer: 0 },
          },
        ]),
      ).ok,
    ).toBe(false);
  });

  it('rejects duplicate refs and refs outside the pattern', () => {
    expect(messages(template([panel('a'), note('a')]))).toEqual([
      'Duplicate ref "a"',
    ]);
    expect(parseBoardTemplate(template([panel('has space')])).ok).toBe(false);
    expect(parseBoardTemplate(template([panel('x'.repeat(65))])).ok).toBe(
      false,
    );
    expect(parseBoardTemplate(template([panel('a-b_c.d:1')])).ok).toBe(true);
    ['__proto__', 'constructor', 'prototype'].forEach((ref) => {
      expect(parseBoardTemplate(template([panel(ref)])).ok).toBe(false);
    });
  });

  it('only accepts http(s) image and vector urls', () => {
    ['image', 'vector'].forEach((type) => {
      const kind = type as 'image' | 'vector';

      expect(
        parseBoardTemplate(template([asset(kind, 'http://example.com/a')])).ok,
      ).toBe(true);
      expect(parseBoardTemplate(template([asset(kind, 'a1b2.png')])).ok).toBe(
        false,
      );
      expect(
        parseBoardTemplate(template([asset(kind, '/api/uploads/a1b2.png')])).ok,
      ).toBe(false);
      expect(
        parseBoardTemplate(
          template([asset(kind, 'data:image/svg+xml;base64,PHN2Zz4=')]),
        ).ok,
      ).toBe(false);
    });
  });

  it("accepts the web app's own template art, and nothing like it", () => {
    const accepted = [
      'assets/templates/movie-retrospective/cinema-v1.svg',
      'assets/templates/movie-retrospective/thumbnail-v1.webp',
      'assets/templates/a_b-c/d.png',
      'assets/templates/x.svg',
    ];
    const rejected = [
      // traversal and empty segments
      'assets/templates/../../../etc/passwd.svg',
      'assets/templates/a/../b.svg',
      'assets/templates/a/..svg',
      'assets/templates//a.svg',
      'assets/templates/a//b.svg',
      'assets/templates/a/.svg',
      'assets/templates/a/-.svg',
      'assets/templates/a/_b.svg',
      'assets/templates/0/_/-.png',
      'assets/templates/-a/b.svg',
      'assets/templates/a/.hidden.svg',
      'assets/templates/a/',
      // absolute or other folders
      '/assets/templates/a.svg',
      './assets/templates/a.svg',
      'assets/x.svg',
      'assets/templatesx/a.svg',
      'https:assets/templates/a.svg',
      '//evil.example/assets/templates/a.svg',
      // query strings, fragments and odd characters
      'assets/templates/a.svg?x=1',
      'assets/templates/a.svg#f',
      'assets/templates/A.svg',
      'assets/templates/a.SVG',
      'assets/templates/a b.svg',
      'assets/templates/a%2e.svg',
      'assets/templates/a\\b.svg',
      'assets/templates/_a.svg',
      'assets/templates/a.svg\n',
      'assets/templates/a.jpg',
      'assets/templates/a.svg.html',
    ];

    accepted.forEach((url) => {
      expect(isAppTemplateAssetUrl(url), url).toBe(true);
      expect(isPortableAssetUrl(url), url).toBe(true);
    });
    rejected.forEach((url) => {
      expect(isAppTemplateAssetUrl(url), url).toBe(false);
      expect(isPortableAssetUrl(url), url).toBe(false);
    });

    ['image', 'vector'].forEach((type) => {
      const kind = type as 'image' | 'vector';

      accepted.forEach((url) => {
        expect(parseBoardTemplate(template([asset(kind, url)])).ok, url).toBe(
          true,
        );
      });
      rejected.forEach((url) => {
        expect(parseBoardTemplate(template([asset(kind, url)])).ok, url).toBe(
          false,
        );
      });
    });
  });

  it('requires arrow attachments to point at a ref of the template', () => {
    expect(parseBoardTemplate(template([note(), arrow('a', 'n')])).ok).toBe(
      true,
    );
    expect(messages(template([note(), arrow('a', 'missing')]))).toEqual([
      'Attachment "missing" is not a ref in this template',
    ]);
  });

  it('enforces the limits', () => {
    const far = panel();

    far.content.position = { x: TEMPLATE_LIMITS.maxCoord + 1, y: 0 };
    expect(parseBoardTemplate(template([far])).ok).toBe(false);

    const huge = panel();

    huge.content.width = TEMPLATE_LIMITS.maxNodeSize + 1;
    expect(parseBoardTemplate(template([huge])).ok).toBe(false);

    const away = arrow('a');

    away.content.start = { x: 1e12, y: 0 };
    expect(parseBoardTemplate(template([away]))).toMatchObject({
      ok: false,
      issues: [{ path: ['nodes', 0, 'content', 'start', 'x'] }],
    });

    const scribble = note();

    scribble.content.drawing = [
      { color: '#000000', size: 2, points: [{ x: 0, y: -1e12 }] },
    ] as never[];
    expect(parseBoardTemplate(template([scribble])).ok).toBe(false);

    const wordy = note();

    wordy.content.text = 'x'.repeat(TEMPLATE_LIMITS.maxTextChars + 1);
    expect(parseBoardTemplate(template([wordy])).ok).toBe(false);

    expect(parseBoardTemplate(template([])).ok).toBe(false);
    expect(
      parseBoardTemplate(
        template(
          Array.from({ length: TEMPLATE_LIMITS.maxNodes + 1 }, (_, i) =>
            note(`n${i}`),
          ),
        ),
      ).ok,
    ).toBe(false);
  });

  it('limits the serialised size', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => {
      const it = note(`n${i}`);

      it.content.text = 'x'.repeat(19_000);
      return it;
    });

    expect(messages(template(nodes))).toEqual([
      expect.stringMatching(/the limit is 512000/),
    ]);
  });

  it('exposes the schema for other validators', () => {
    expect(boardTemplateDataSchema.safeParse(template([panel()])).success).toBe(
      true,
    );
  });
});
