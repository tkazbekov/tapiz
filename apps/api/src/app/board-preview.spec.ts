import { Resvg } from '@resvg/resvg-js';
import { vi } from 'vitest';
import type { TuNode } from '@tapiz/board-commons';
import {
  buildBoardPreviewSvg,
  clearPreviewAssetCache,
  isPreviewAssetUrl,
  loadPreviewAssets,
  MAX_PREVIEW_HEIGHT,
  previewImageSize,
  renderBoardPreview,
  safeColor,
} from './board-preview.js';
import { PreviewRenderError, renderSvgToPng } from './preview-renderer.js';

const region = { x: 0, y: 0, width: 1000, height: 800 };

const note = (id: string, content: Record<string, unknown> = {}): TuNode => ({
  id,
  type: 'note',
  content: {
    text: '<p>Hello</p>',
    position: { x: 10, y: 10 },
    layer: 0,
    ownerId: 'owner',
    votes: [],
    emojis: [],
    drawing: [],
    width: 300,
    height: 300,
    ...content,
  },
});

const panel = (id: string, content: Record<string, unknown> = {}): TuNode => ({
  id,
  type: 'panel',
  content: {
    text: '',
    position: { x: 400, y: 10 },
    layer: 0,
    width: 400,
    height: 300,
    rotation: 0,
    drawing: [],
    ...content,
  },
});

const vector = (id: string, url: string): TuNode => ({
  id,
  type: 'vector',
  content: {
    url,
    position: { x: 50, y: 400 },
    layer: 1,
    width: 200,
    height: 200,
    rotation: 0,
  },
});

const svgOf = (nodes: TuNode[], assets = new Map<string, string>()) =>
  buildBoardPreviewSvg(nodes, region, { width: 500, assets });

// resvg parses the SVG as XML and throws when it is not well formed
const parses = (svg: string) =>
  new Resvg(svg, { font: { loadSystemFonts: false } }).render().width > 0;

const svgResponse = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/svg+xml', ...headers },
  });

const STAR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

// resvg 2.6 aborts the process on a layer group far outside the canvas;
// the crash tests below pin that, so revisit them when upgrading resvg
const PANIC_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="692" height="78" viewBox="0 3000 692 78"><g opacity="0.5"><rect width="300" height="80"/></g></svg>';

const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

describe('board preview', () => {
  beforeEach(() => clearPreviewAssetCache());

  describe('buildBoardPreviewSvg', () => {
    it('escapes text so board content cannot inject markup', () => {
      const evil =
        '</text><script>alert(1)</script> ]]> <![CDATA[ x & y "q" \'a\' \u0001';
      const svg = svgOf([
        note('n1', {
          text: `<p>${evil.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>`,
        }),
        panel('p1', { text: `<p><span style="color: red">${evil}</span></p>` }),
        {
          id: 't1',
          type: 'text',
          content: {
            text: '<h1>&lt;script&gt;alert(2)&lt;/script&gt;</h1>',
            position: { x: 0, y: 500 },
            layer: 0,
            width: 900,
            height: 300,
            rotation: 0,
          },
        },
        {
          id: 'g1',
          type: 'group',
          content: {
            title: '<script>alert(3)</script>',
            position: { x: 0, y: 0 },
            layer: 0,
            width: 900,
            height: 700,
            votes: [],
          },
        },
        {
          id: 'x1',
          type: '"><script>',
          content: { position: { x: 5, y: 5 }, width: 50, height: 50 },
        },
      ]);

      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toContain('<![CDATA[');
      expect(svg).not.toContain('\u0001');
      expect(svg).toContain('&lt;script&gt;');
      expect(svg).toContain('&amp;');
      expect(parses(svg)).toBe(true);
    });

    it('only lets hex and rgb-like colors through', () => {
      expect(safeColor('#fff', 'x')).toBe('#fff');
      expect(safeColor('#a1b2c3d4', 'x')).toBe('#a1b2c3d4');
      expect(safeColor('rgb(1, 2, 3)', 'x')).toBe('rgb(1, 2, 3)');
      expect(safeColor('rgba(1,2,3,0.5)', 'x')).toBe('rgba(1,2,3,0.5)');
      expect(safeColor('transparent', 'x')).toBe('none');
      expect(safeColor('red" onload="x', 'x')).toBe('x');
      expect(safeColor('url(#evil)', 'x')).toBe('x');
      expect(safeColor(null, 'x')).toBe('x');

      const svg = svgOf([
        note('n1', { color: '"/><script>' }),
        panel('p1', { backgroundColor: 'url(http://evil)', borderWidth: 2 }),
      ]);

      expect(svg).toContain('fill="#fbb980"');
      expect(svg).toContain('fill="#ffffff"');
      expect(svg).not.toContain('evil');
      expect(parses(svg)).toBe(true);
    });

    it('renders a masked note blank', () => {
      // what maskNodesForViewer hands over for someone else's hidden note
      const svg = svgOf([note('n1', { text: '', color: '#ff0000' })]);

      expect(svg).toContain('fill="#ff0000"');
      expect(svg).not.toContain('<text');
    });

    it('hides the text of a textHidden note from everyone but its owner', () => {
      const hidden = note('n1', { text: '<p>secret</p>', textHidden: true });

      expect(svgOf([hidden])).not.toContain('secret');
      expect(
        buildBoardPreviewSvg([hidden], region, {
          width: 500,
          assets: new Map(),
          viewerId: 'owner',
        }),
      ).toContain('secret');
    });

    it('rotates nodes about their top-left corner', () => {
      const svg = svgOf([panel('p1', { rotation: 15 })]);

      expect(svg).toContain('transform="translate(400 10) rotate(15)"');
    });

    it('renders rich text one block per line with sizes, bold and color', () => {
      const svg = svgOf([
        panel('p1', {
          width: 800,
          text: '<p><span style="color: #ff0000; font-size: 40px"><strong>Title</strong></span></p><p>body &amp; more</p>',
        }),
      ]);

      expect(svg).toMatch(
        /<text [^>]*font-size="40"[^>]*><tspan font-weight="700" fill="#ff0000">Title<\/tspan><\/text>/,
      );
      expect(svg).toMatch(
        /font-size="24"[^>]*><tspan>body &amp; more<\/tspan>/,
      );
    });

    it('wraps long text within the box', () => {
      const svg = svgOf([
        panel('p1', {
          width: 200,
          text: '<p>one two three four five six seven eight nine ten</p>',
        }),
      ]);

      expect(svg.match(/<text /g)?.length).toBeGreaterThan(2);
    });

    it('uses the data uri of a loaded asset, else a placeholder', () => {
      const url = 'https://cocomaterial.com/media/star.svg';
      const dataUri = `data:image/svg+xml;base64,${Buffer.from(STAR).toString('base64')}`;

      expect(svgOf([vector('v1', url)], new Map([[url, dataUri]]))).toContain(
        `<image href="${dataUri}"`,
      );

      const placeholder = svgOf([vector('v1', 'https://evil.example/x.svg')]);

      expect(placeholder).not.toContain('<image');
      expect(placeholder).not.toContain('evil.example');
      expect(placeholder).toContain('>vector</text>');
    });

    it('draws arrows with heads, attached to their nodes', () => {
      const svg = svgOf([
        panel('p1'),
        {
          id: 'a1',
          type: 'arrow',
          content: {
            position: { x: 0, y: 0 },
            layer: 0,
            width: 10,
            height: 10,
            start: { x: 100, y: 100 },
            end: { x: 0, y: 0 },
            strokeStyle: 'dashed',
            arrowType: 'sharp',
            endAttachment: { nodeId: 'p1', offset: { x: 0, y: 0 } },
          },
        },
      ]);

      expect(svg).toContain('<path d="M 100 100 L 400 10"');
      expect(svg).toContain('stroke-dasharray');
      expect(svg).toContain('<polygon points="400,10 ');
    });

    it('never emits clip or opacity groups and drops overflowing lines', () => {
      const svg = svgOf([
        panel('p1', {
          width: 200,
          height: 100,
          text: `<p>${'word '.repeat(200)}</p>`,
          drawing: [
            {
              points: [
                { x: 1, y: 1 },
                { x: 900, y: 900 },
              ],
            },
          ],
        }),
      ]);

      expect(svg).not.toContain('clip');
      expect(svg).not.toContain('opacity');
      // 74px of text box at 28.8px a line
      expect(svg.match(/<text /g)?.length).toBe(3);
    });

    it('colours a note like the panel holding it, as the web does', () => {
      const inside = note('n1', {
        position: { x: 420, y: 20 },
        width: 100,
        height: 100,
      });
      const across = note('n2', { position: { x: 700, y: 20 } });
      const svg = svgOf([
        panel('p1', { color: '#00ff00' }),
        panel('p2', { color: 'url(#x)', position: { x: 2000, y: 0 } }),
        inside,
        across,
      ]);

      expect(svg).toMatch(/translate\(420 20\)"><rect [^>]*fill="#00ff00"/);
      expect(svg).toMatch(/translate\(700 20\)"><rect [^>]*fill="#fbb980"/);
    });

    it('bends curved arrows out of the side they are attached to', () => {
      const svg = svgOf([
        panel('p1', { position: { x: 100, y: 100 }, width: 200, height: 100 }),
        {
          id: 'a1',
          type: 'arrow',
          content: {
            position: { x: 190, y: 190 },
            layer: 0,
            width: 320,
            height: 20,
            start: { x: 10, y: 10 },
            end: { x: 310, y: 10 },
            arrowType: 'curved',
            // the middle of the bottom side
            startAttachment: { nodeId: 'p1', offset: { x: 100, y: 100 } },
          },
        },
      ]);
      const [, x1, y1] =
        /<path d="M 200 200 C ([\d.-]+) ([\d.-]+),/.exec(svg) ?? [];

      // straight down, not sideways
      expect(Number(x1)).toBe(200);
      expect(Number(y1)).toBeGreaterThan(200);
    });

    it('skips nodes outside the region and runtime nodes', () => {
      const svg = svgOf([
        panel('far', { position: { x: 5000, y: 5000 } }),
        { id: 's', type: 'settings', content: {} },
        { id: 'u', type: 'user', content: { name: 'x' } },
      ]);

      expect(svg).not.toContain('translate(5000');
      expect(parses(svg)).toBe(true);
    });
  });

  describe('loadPreviewAssets', () => {
    it('accepts only https cocomaterial urls', () => {
      expect(isPreviewAssetUrl('https://cocomaterial.com/media/a.svg')).toBe(
        true,
      );
      // the layout allowlist: exactly cocomaterial.com
      expect(isPreviewAssetUrl('https://cdn.cocomaterial.com/a.svg')).toBe(
        false,
      );
      expect(isPreviewAssetUrl('http://cocomaterial.com/media/a.svg')).toBe(
        false,
      );
      expect(isPreviewAssetUrl('https://cocomaterial.com.evil.io/a.svg')).toBe(
        false,
      );
      expect(isPreviewAssetUrl('https://evilcocomaterial.com/a.svg')).toBe(
        false,
      );
      expect(
        isPreviewAssetUrl('https://user:pw@cocomaterial.com/media/a.svg'),
      ).toBe(false);
      expect(isPreviewAssetUrl('https://cocomaterial.com:8443/a.svg')).toBe(
        false,
      );
      expect(isPreviewAssetUrl('upload-abc.png')).toBe(false);
    });

    it('never fetches other hosts, http or upload names', async () => {
      const fetchSpy = vi.fn<typeof fetch>();
      const urls = [
        'http://cocomaterial.com/media/a.svg',
        'https://example.com/a.svg',
        'https://169.254.169.254/latest',
        'uploads/123.png',
        'file:///etc/passwd',
      ];

      const { assets, skipped } = await loadPreviewAssets(
        urls.map((url, index) => vector(`v${index}`, url)),
        { fetch: fetchSpy },
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(assets.size).toBe(0);
      expect(skipped.map((it) => it.url).sort()).toEqual([...urls].sort());
    });

    it('fetches cocomaterial art once, without following redirects', async () => {
      const url = 'https://cocomaterial.com/media/fetch-once.svg';
      const fetchSpy = vi.fn<typeof fetch>(async () => svgResponse(STAR));

      const first = await loadPreviewAssets([vector('v1', url)], {
        fetch: fetchSpy,
      });
      const second = await loadPreviewAssets([vector('v1', url)], {
        fetch: fetchSpy,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
      expect(first.assets.get(url)).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(second.assets.get(url)).toBe(first.assets.get(url));
    });

    it('skips redirects, wrong content types and oversize bodies', async () => {
      const big = new Uint8Array(3 * 1024 * 1024);
      const responses: Record<string, () => Response> = {
        'https://cocomaterial.com/media/redirect.svg': () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/' },
          }),
        'https://cocomaterial.com/media/html.svg': () =>
          new Response('<html></html>', {
            headers: { 'content-type': 'text/html' },
          }),
        'https://cocomaterial.com/media/declared.svg': () =>
          svgResponse('x', { 'content-length': String(big.byteLength) }),
        'https://cocomaterial.com/media/streamed.svg': () =>
          svgResponse(
            new ReadableStream({
              start(controller) {
                controller.enqueue(big);
                controller.close();
              },
            }),
          ),
      };
      const fetchSpy = vi.fn<typeof fetch>(async (input) =>
        responses[String(input)](),
      );

      const { assets, skipped } = await loadPreviewAssets(
        Object.keys(responses).map((url, index) => vector(`v${index}`, url)),
        { fetch: fetchSpy },
      );

      expect(assets.size).toBe(0);
      expect(
        Object.fromEntries(skipped.map((it) => [it.url, it.reason])),
      ).toEqual({
        'https://cocomaterial.com/media/redirect.svg': 'redirect',
        'https://cocomaterial.com/media/html.svg': 'content-type text/html',
        'https://cocomaterial.com/media/declared.svg': 'too large',
        'https://cocomaterial.com/media/streamed.svg': 'too large',
      });
    });

    it('fetches an asset once whatever its query string', async () => {
      const fetchSpy = vi.fn<typeof fetch>(async () => svgResponse(STAR));
      const urls = [1, 2, 3].map(
        (n) => `https://cocomaterial.com/media/q.svg?n=${n}#f`,
      );
      const { assets } = await loadPreviewAssets(
        urls.map((url, index) => vector(`v${index}`, url)),
        { fetch: fetchSpy },
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://cocomaterial.com/media/q.svg',
      );
      expect([...assets.keys()].sort()).toEqual(urls);
    });

    it('drops external references inside fetched svg', async () => {
      const url = 'https://cocomaterial.com/media/refs.svg';
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="/etc/x.png"/><use xlink:href=\'#a\'/><image xlink:href="file:///y.png"/></svg>';
      const { assets } = await loadPreviewAssets([vector('v1', url)], {
        fetch: async () => svgResponse(svg),
      });
      const decoded = Buffer.from(
        (assets.get(url) ?? '').split(',')[1],
        'base64',
      ).toString('utf8');

      expect(decoded).not.toContain('/etc/x.png');
      expect(decoded).not.toContain('file:');
      expect(decoded).toContain("xlink:href='#a'");
    });
  });

  describe('renderBoardPreview', () => {
    it('renders a small board to a PNG', async () => {
      const fetchSpy = vi.fn<typeof fetch>();
      const { png, skipped, scale } = await renderBoardPreview(
        [
          note('n1', { rotation: 10 }),
          panel('p1', { text: '<p>Panel <strong>bold</strong></p>' }),
          vector('v1', 'https://example.com/not-fetched.svg'),
        ],
        region,
        400,
        { fetch: fetchSpy },
      );

      expect([...png.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect(scale).toBeCloseTo(0.4);
      expect(skipped).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('caps the height of a tall region', async () => {
      const { png, scale } = await renderBoardPreview(
        [],
        { x: 0, y: 0, width: 100, height: 100000 },
        1200,
      );

      expect(100000 * scale).toBeLessThanOrEqual(MAX_PREVIEW_HEIGHT);
      expect(pngSize(png).height).toBeLessThanOrEqual(MAX_PREVIEW_HEIGHT);
      expect(pngSize(png).width).toBeGreaterThanOrEqual(1);
    });

    it('refuses regions too small or too thin to draw', async () => {
      const thin = [
        { x: 10, y: 0, width: 0.001, height: 1e7 },
        { x: 0, y: 0, width: 1e-6, height: 1 },
        { x: 10, y: 0, width: 10, height: 1e7 },
        { x: 0, y: 0, width: 1e12, height: 460 },
      ];

      for (const thinRegion of thin) {
        expect(previewImageSize(thinRegion, 1200)).toBeNull();
        await expect(
          renderBoardPreview([note('n1')], thinRegion, 1200),
        ).rejects.toThrow(/too thin/);
      }

      // a far-away note makes a tall content region: narrow, never too tall
      const tall = previewImageSize(
        { x: -80, y: -80, width: 460, height: 3e6 },
        1200,
      );

      expect(tall).toBeNull();
      expect(
        previewImageSize({ x: 0, y: 0, width: 460, height: 300000 }, 1200),
      ).toMatchObject({ width: 7, height: 4800 });
    });

    it('renders a region cutting through a tall panel', async () => {
      // a header far above the canvas used to abort the process in resvg
      const nodes = [
        panel('p1', {
          position: { x: 0, y: 0 },
          width: 700,
          height: 3000,
          text: '<p><span style="font-size: 48px">Went well</span></p>',
          drawing: [
            {
              points: [
                { x: 5, y: 5 },
                { x: 50, y: 50 },
              ],
              size: 2,
            },
          ],
        }),
        note('n1', { position: { x: 40, y: 2600 } }),
      ];

      for (const cut of [
        { x: -40, y: 2520, width: 460, height: 460 },
        { x: -265, y: 732, width: 2119, height: 363 },
        { x: 600, y: 2900, width: 1, height: 100 },
      ]) {
        const { png } = await renderBoardPreview(nodes, cut, 1200);

        expect(pngSize(png).width).toBeGreaterThan(0);
      }
    });

    it('drops art that makes the renderer fail', async () => {
      // the part of the art outside the canvas has a layer group
      const art =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 1000"><rect width="100" height="1000" fill="red"/><g opacity="0.5"><circle cx="50" cy="20" r="10"/></g></svg>';
      const url = 'https://cocomaterial.com/media/layered.svg';
      const tallArt: TuNode = {
        ...vector('v1', url),
        content: {
          ...vector('v1', url).content,
          position: { x: 0, y: 80 },
          width: 300,
          height: 3000,
        },
      };
      const { png, skipped } = await renderBoardPreview(
        [tallArt],
        { x: 0, y: 3000, width: 692, height: 78 },
        692,
        { fetch: async () => svgResponse(art) },
      );

      expect(pngSize(png)).toEqual({ width: 692, height: 78 });
      expect(skipped).toEqual([{ url, reason: 'could not be rendered' }]);
    });
  });

  describe('renderSvgToPng', () => {
    it('contains a renderer crash in the child process', async () => {
      const error = await renderSvgToPng(PANIC_SVG, {
        font: { loadSystemFonts: false },
      }).catch((it: unknown) => it);

      expect(error).toBeInstanceOf(PreviewRenderError);
      expect((error as PreviewRenderError).crashed).toBe(true);

      // this process is still alive and renders the next one
      const png = await renderSvgToPng(
        PANIC_SVG.replace('<g opacity="0.5">', '<g>'),
        { font: { loadSystemFonts: false } },
      );

      expect(pngSize(png)).toEqual({ width: 692, height: 78 });
    });
  });
});
