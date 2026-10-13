import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';

import { createRichTextSanitizer } from '../rich-text/rich-text-sanitizer.js';
import {
  escapeHtmlText,
  plainHtml,
  presetHtml,
  TEXT_PRESETS,
  type TextPreset,
} from './text-presets.js';

const sanitize = createRichTextSanitizer(
  createDOMPurify(new JSDOM('').window as unknown as WindowLike),
);

// libs/ui option-typography.component.ts
const EDITOR_FONT_SIZES = [
  8, 10, 12, 14, 16, 18, 20, 28, 32, 40, 48, 64, 80, 96, 128, 160, 240, 320,
];

const presets = Object.keys(TEXT_PRESETS) as TextPreset[];

describe('text presets', () => {
  it('only uses sizes from the editor dropdown or its default', () => {
    presets.forEach((preset) => {
      const { fontSize } = TEXT_PRESETS[preset];

      if (fontSize !== null) {
        expect(EDITOR_FONT_SIZES).toContain(fontSize);
      }
    });
  });

  it('renders a bold heading with <strong> and inline styles', () => {
    expect(
      presetHtml({ preset: 'heading', text: 'Went well', align: 'center' }),
    ).toBe(
      '<p style="text-align: center"><span style="font-size: 40px; line-height: 1.2"><strong>Went well</strong></span></p>',
    );
  });

  it('renders body text at the default size and captions in grey', () => {
    expect(presetHtml({ preset: 'body', text: 'Hi' })).toBe(
      '<p><span style="line-height: 1.3">Hi</span></p>',
    );
    expect(presetHtml({ preset: 'caption', text: 'Hi' })).toBe(
      '<p><span style="color: #868e96; font-size: 18px; line-height: 1.3">Hi</span></p>',
    );
  });

  it('escapes only &, <, > and no-break spaces in text', () => {
    expect(escapeHtmlText('<script>"a" & \'b\'</script>\u00a0')).toBe(
      '&lt;script&gt;"a" &amp; \'b\'&lt;/script&gt;&nbsp;',
    );
    expect(presetHtml({ preset: 'label', text: '<b>x</b>' })).not.toContain(
      '<b>',
    );
  });

  it('splits lines into paragraphs', () => {
    expect(plainHtml('one\ntwo\r\nthree\rfour')).toBe(
      '<p>one</p><p>two</p><p>three</p><p>four</p>',
    );
    expect(presetHtml({ preset: 'title', text: 'a\n\nb' })).toBe(
      '<p><span style="font-size: 64px; line-height: 1.15"><strong>a</strong></span></p><p></p><p><span style="font-size: 64px; line-height: 1.15"><strong>b</strong></span></p>',
    );
  });

  it('never emits h1-h3', () => {
    const html = presetHtml(
      presets.map((preset) => ({ preset, text: 'Heading' })),
    );

    expect(html).not.toMatch(/<h[1-6]/);
  });

  it('is left unchanged by the rich-text sanitizer', () => {
    const text =
      'Tom\'s "quoted" <tag> & more\nsecond\u00a0line, 50% off\r\n\rend';
    const outputs = [
      ...presets.map((preset) => presetHtml({ preset, text })),
      ...presets.map((preset) => presetHtml({ preset, text, align: 'right' })),
      presetHtml(presets.map((preset) => ({ preset, text: preset }))),
      plainHtml(text),
    ];

    outputs.forEach((html) => {
      expect(sanitize(html)).toBe(html);
    });
  });
});
