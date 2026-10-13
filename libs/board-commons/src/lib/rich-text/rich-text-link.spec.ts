import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';

import { normalizeLinkUrl } from './rich-text-link.js';
import { createRichTextSanitizer } from './rich-text-sanitizer.js';

const sanitize = createRichTextSanitizer(
  createDOMPurify(new JSDOM('').window as unknown as WindowLike),
);

describe('normalizeLinkUrl', () => {
  it('keeps links with an allowed scheme', () => {
    expect(normalizeLinkUrl(' https://example.com/a?b=1 ')).toBe(
      'https://example.com/a?b=1',
    );
    expect(normalizeLinkUrl('HTTP://example.com')).toBe('HTTP://example.com');
    expect(normalizeLinkUrl('mailto:a@example.com')).toBe(
      'mailto:a@example.com',
    );
    expect(normalizeLinkUrl('tel:+123456')).toBe('tel:+123456');
  });

  it('turns addresses without a scheme into https links', () => {
    expect(normalizeLinkUrl('example.com')).toBe('https://example.com');
    expect(normalizeLinkUrl('www.example.com/path')).toBe(
      'https://www.example.com/path',
    );
    expect(normalizeLinkUrl('localhost:4300/board')).toBe(
      'https://localhost:4300/board',
    );
  });

  it('refuses other schemes, relative links and empty text', () => {
    for (const url of [
      '',
      '   ',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '/board',
      '//evil.test',
      '#top',
      'https://',
    ]) {
      expect(normalizeLinkUrl(url)).toBe('');
    }
  });

  it('only produces hrefs the sanitizer keeps', () => {
    for (const url of [
      'example.com',
      'https://example.com',
      'mailto:a@example.com',
      'tel:+123456',
      'localhost:4300',
    ]) {
      const href = normalizeLinkUrl(url);

      expect(sanitize(`<a href="${href}">x</a>`)).toContain(`href="${href}"`);
    }
  });
});
