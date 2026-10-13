import {
  estimateHtmlHeight,
  estimateNoteFontPx,
  estimatePanelTextBottom,
  estimateTextNodeHeight,
} from './text-estimate.js';
import { presetHtml } from './text-presets.js';

describe('text estimate', () => {
  it('grows with the length of the text', () => {
    const heights = [1, 10, 50, 200].map(
      (words) =>
        estimateHtmlHeight(`<p>${'word '.repeat(words)}</p>`, 400).height,
    );

    heights.slice(1).forEach((height, index) => {
      expect(height).toBeGreaterThanOrEqual(heights[index]);
    });
    expect(heights[3]).toBeGreaterThan(heights[0]);
  });

  it('counts paragraphs and line breaks', () => {
    expect(estimateHtmlHeight('<p>a</p><p>b</p>', 400).lines).toBe(2);
    expect(estimateHtmlHeight('<p>a<br>b</p>', 400).lines).toBe(2);
    expect(estimateHtmlHeight('<p></p>', 400).lines).toBe(1);
    expect(estimateHtmlHeight('', 400)).toEqual({
      height: 0,
      lines: 0,
      maxFontPx: 0,
    });
  });

  it('reads font sizes from spans and headings', () => {
    const title = estimateHtmlHeight(
      presetHtml({ preset: 'title', text: 'Retro' }),
      1000,
    );
    const h1 = estimateHtmlHeight('<h1>Retro</h1>', 1000);

    expect(title.maxFontPx).toBe(64);
    expect(h1.maxFontPx).toBe(320);
    expect(h1.height).toBeGreaterThan(title.height * 4);
    expect(estimateHtmlHeight('<p>x</p>', 1000).maxFontPx).toBe(24);
  });

  it('breaks words longer than the line', () => {
    const word = 'x'.repeat(100);

    expect(estimateHtmlHeight(`<p>${word}</p>`, 24 * 0.55 * 10).lines).toBe(10);
  });

  it('decodes entities before measuring', () => {
    expect(
      estimateHtmlHeight('<p>&amp;&amp;&amp;</p>', 3 * 24 * 0.55).lines,
    ).toBe(1);
  });

  it('measures text nodes and panel headers inside their borders', () => {
    const html = presetHtml({ preset: 'heading', text: 'Went well' });

    expect(estimateTextNodeHeight(html, 600)).toBe(
      estimateHtmlHeight(html, 598).height,
    );
    expect(estimatePanelTextBottom(html, 600)).toBe(
      13 + estimateHtmlHeight(html, 574).height,
    );
  });

  it('ignores entity names that are not entities', () => {
    expect(estimateHtmlHeight('<p>&constructor;</p>', 300)).toEqual(
      estimateHtmlHeight('<p>&unknown;</p>', 300),
    );
    expect(estimateHtmlHeight('<p>&constructor;</p>', 300).lines).toBe(1);
  });

  it('stays fast on unbalanced markup', () => {
    const inputs = ['<'.repeat(20_000), '<p '.repeat(6666), '<p>'.repeat(6666)];
    const started = performance.now();

    inputs.forEach((html) => {
      estimateHtmlHeight(html, 300);
      estimateNoteFontPx(html, 300, 300);
    });

    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads blocks up to the next closing tag of their kind', () => {
    expect(estimateHtmlHeight('<p>a<p>b</p><li>c</li>', 300)).toEqual(
      estimateHtmlHeight('<p>ab</p><li>c</li>', 300),
    );
    expect(estimateHtmlHeight('<p>a</p><p>b</p>', 300).lines).toBe(2);
  });

  describe('estimateNoteFontPx', () => {
    it('keeps short text near the maximum size', () => {
      expect(estimateNoteFontPx('<p>Ship it</p>', 300, 300)).toBe(45);
    });

    it('shrinks long text', () => {
      const long = `<p>${'a fairly long sentence '.repeat(30)}</p>`;
      const font = estimateNoteFontPx(long, 300, 300);

      expect(font).toBeLessThan(18);
      expect(font).toBeGreaterThanOrEqual(1);
    });

    it('fits more text on a larger note', () => {
      const text = `<p>${'word '.repeat(60)}</p>`;

      expect(estimateNoteFontPx(text, 600, 600)).toBeGreaterThan(
        estimateNoteFontPx(text, 300, 300),
      );
    });
  });
});
