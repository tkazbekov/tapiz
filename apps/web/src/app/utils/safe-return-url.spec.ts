import { describe, expect, it } from 'vitest';
import { safeReturnUrl } from './safe-return-url';

describe('safeReturnUrl', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeReturnUrl('/board/1?nodeId=2#x')).toBe('/board/1?nodeId=2#x');
    expect(safeReturnUrl('/settings')).toBe('/settings');
  });

  it.each([
    null,
    undefined,
    '',
    'board/1',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'javascript:alert(1)',
  ])('falls back for %j', (value) => {
    expect(safeReturnUrl(value)).toBe('/');
  });

  it('uses the given fallback', () => {
    expect(safeReturnUrl('//evil.example', '/login')).toBe('/login');
  });
});
