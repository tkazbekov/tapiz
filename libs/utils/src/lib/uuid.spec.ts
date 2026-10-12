import { uuid } from './uuid';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a v4 uuid', () => {
    expect(uuid()).toMatch(V4);
  });

  it('falls back to getRandomValues outside secure contexts', () => {
    const webCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) =>
        webCrypto.getRandomValues(array),
    });

    const ids = new Set(Array.from({ length: 50 }, () => uuid()));

    expect(ids.size).toBe(50);
    ids.forEach((id) => expect(id).toMatch(V4));
  });
});
