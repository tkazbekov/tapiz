import { deepEqual } from './deep-equal';

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
  });

  it('compares nested objects regardless of key order', () => {
    expect(
      deepEqual(
        { id: '1', content: { x: 1, list: [1, 2] } },
        { content: { list: [1, 2], x: 1 }, id: '1' },
      ),
    ).toBe(true);
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('compares arrays by order and length', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1], [1, 1])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });
});
