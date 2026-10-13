import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';

import {
  createRichTextSanitizer,
  sanitizeNodeRichText,
  sanitizeStateActionRichText,
  sanitizeStyle,
} from './rich-text-sanitizer.js';

const sanitize = createRichTextSanitizer(
  createDOMPurify(new JSDOM('').window as unknown as WindowLike),
);

describe('sanitizeStyle', () => {
  it('keeps the tiptap text style and alignment properties', () => {
    expect(
      sanitizeStyle(
        'color: #ff0000; font-family: "Inter", sans-serif; font-size: 24px; text-align: center; line-height: 1.2; background-color: rgb(1, 2, 3)',
      ),
    ).toBe(
      'color: #ff0000; font-family: "Inter", sans-serif; font-size: 24px; text-align: center; line-height: 1.2; background-color: rgb(1, 2, 3)',
    );
  });

  it('drops properties and values outside the allowlist', () => {
    expect(
      sanitizeStyle(
        'position: fixed; inset: 0; background-image: url(https://evil.test/x); color: red; font-family: x\\3a expression(alert(1)); font-size: calc(100vw)',
      ),
    ).toBe('color: red');
  });

  it('returns an empty string when nothing is allowed', () => {
    expect(sanitizeStyle('behavior: url(x.htc)')).toBe('');
  });
});

describe('createRichTextSanitizer', () => {
  it('removes script elements', () => {
    expect(sanitize('<p>hi<script>alert(1)</script></p>')).toBe('<p>hi</p>');
  });

  it('removes event handler attributes and non-allowlisted elements', () => {
    const result = sanitize(
      '<p>a</p><img src=x onerror="alert(document.domain)"><svg onload="alert(1)"></svg><iframe src="https://evil.test"></iframe>',
    );

    expect(result).toBe('<p>a</p>');
  });

  it('removes javascript: and data: hrefs', () => {
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitize('<a href=" jav&#x09;ascript:alert(1)">x</a>')).toBe(
      '<a>x</a>',
    );
    expect(
      sanitize('<a href="data:text/html,<script>alert(1)</script>">x</a>'),
    ).toBe('<a>x</a>');
  });

  it('forces safe target and rel on links', () => {
    expect(
      sanitize(
        '<a href="https://example.com" target="_self" rel="opener">x</a>',
      ),
    ).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitize('<a href="mailto:a@example.com">mail</a>')).toBe(
      '<a href="mailto:a@example.com" target="_blank" rel="noopener noreferrer nofollow">mail</a>',
    );
    expect(sanitize('<a href="tel:+123">call</a>')).toBe(
      '<a href="tel:+123" target="_blank" rel="noopener noreferrer nofollow">call</a>',
    );
  });

  it('filters style injection', () => {
    expect(
      sanitize(
        '<span style="color: red; background-image: url(https://evil.test/leak); position: fixed">x</span>',
      ),
    ).toBe('<span style="color: red">x</span>');
    expect(
      sanitize('<span style="background: url(javascript:alert(1))">x</span>'),
    ).toBe('<span>x</span>');
    expect(sanitize('<style>body{display:none}</style><p>x</p>')).toBe(
      '<p>x</p>',
    );
  });

  it('removes attributes that can clobber the DOM or style the app', () => {
    expect(
      sanitize('<p id="board" name="x" class="cdk-overlay-backdrop">x</p>'),
    ).toBe('<p>x</p>');
  });

  it('preserves the formatting produced by the editors', () => {
    const html =
      '<h1 style="text-align: center">Title</h1><h2>Sub</h2><h3>Small</h3>' +
      '<p><strong>bold</strong> <em>italic</em> <s>strike</s> ' +
      '<span style="color: #ff0000; font-family: Caveat; font-size: 24px">styled</span></p>' +
      '<ul><li><p>one</p></li></ul><ol start="3" type="a"><li><p>three</p></li></ol>' +
      '<p><a href="https://example.com/path?q=1" target="_blank" rel="noopener noreferrer nofollow">link</a><br></p>';

    expect(sanitize(html)).toBe(html);
  });

  it('preserves mentions', () => {
    const html =
      '<p>Hi <span data-type="mention" data-id="5b3a6a2b-6d5e-4b9b-8d1c-6a2f9d4f1c11" data-label="Ana" data-mention-suggestion-char="@">@Ana</span></p>';

    expect(sanitize(html)).toBe(html);
  });

  it('drops other data attributes', () => {
    expect(sanitize('<span data-foo="1" aria-label="x">x</span>')).toBe(
      '<span>x</span>',
    );
  });

  it('is idempotent', () => {
    const html =
      '<p style="text-align: right">a <a href="https://example.com">b</a><img src=x onerror=alert(1)></p>';
    const once = sanitize(html);

    expect(sanitize(once)).toBe(once);
  });

  it('returns an empty string for empty input', () => {
    expect(sanitize('')).toBe('');
  });
});

describe('sanitizeNodeRichText', () => {
  const payload = '<img src=x onerror="alert(1)"><p>ok</p>';

  it.each(['text', 'note', 'panel'])('sanitizes %s content.text', (type) => {
    const node = sanitizeNodeRichText(
      { id: '1', type, content: { text: payload, width: 10 } },
      sanitize,
    );

    expect(node.content).toEqual({ text: '<p>ok</p>', width: 10 });
  });

  it('sanitizes estimation story descriptions', () => {
    const node = sanitizeNodeRichText(
      {
        id: '1',
        type: 'estimation.config',
        content: {
          scale: 'fibonacci',
          stories: [
            { id: 's1', title: 't', description: payload, show: false },
          ],
        },
      },
      sanitize,
    );

    expect(node.content).toEqual({
      scale: 'fibonacci',
      stories: [
        { id: 's1', title: 't', description: '<p>ok</p>', show: false },
      ],
    });
  });

  it('sanitizes nested children', () => {
    const node = sanitizeNodeRichText(
      {
        id: '1',
        type: 'note',
        content: { text: '<p>parent</p>' },
        children: [{ id: '2', type: 'text', content: { text: payload } }],
      },
      sanitize,
    );

    expect(node.children?.[0].content).toEqual({ text: '<p>ok</p>' });
  });

  it('leaves other node types and patches without text untouched', () => {
    const image = { id: '1', type: 'image', content: { url: payload } };
    const patch = { id: '2', type: 'note', content: { width: 10 } };

    expect(sanitizeNodeRichText(image, sanitize)).toEqual(image);
    expect(sanitizeNodeRichText(patch, sanitize)).toEqual(patch);
  });

  it('sanitizes add and patch state actions and skips removes', () => {
    const add = sanitizeStateActionRichText(
      {
        op: 'add',
        data: { id: '1', type: 'text', content: { text: payload } },
      },
      sanitize,
    );
    const remove = { op: 'remove' as const, data: { id: '1', type: 'text' } };

    expect(add.data).toEqual({
      id: '1',
      type: 'text',
      content: { text: '<p>ok</p>' },
    });
    expect(sanitizeStateActionRichText(remove, sanitize)).toBe(remove);
  });
});
