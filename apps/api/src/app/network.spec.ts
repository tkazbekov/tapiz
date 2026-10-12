import type { IncomingMessage } from 'node:http';
import { vi } from 'vitest';
import { createWsAllowRequest, parseTrustProxy } from './network.js';

describe('network', () => {
  it('parses TRUST_PROXY', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(parseTrustProxy(undefined)).toEqual(false);
    expect(parseTrustProxy('')).toEqual(false);
    expect(parseTrustProxy('false')).toEqual(false);
    expect(parseTrustProxy('0')).toEqual(false);
    expect(parseTrustProxy(' 10.0.0.0/8,127.0.0.1 ')).toEqual(
      '10.0.0.0/8,127.0.0.1',
    );
    expect(warn).not.toHaveBeenCalled();

    // hop counts become a function; fastify ignores a plain number
    const trustedHops = (value: string) => {
      const trust = parseTrustProxy(value);

      if (typeof trust !== 'function') {
        throw new Error(`expected a function for ${value}`);
      }

      return [0, 1, 2, 3].filter((hop) => trust('10.0.0.1', hop));
    };

    expect(trustedHops('1')).toEqual([0]);
    expect(trustedHops('2')).toEqual([0, 1]);
    // 'true' trusts one hop rather than every client-supplied entry
    expect(trustedHops('true')).toEqual([0]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it('only allows websocket handshakes from known origins', () => {
    const allowRequest = createWsAllowRequest(
      new Set(['http://localhost:4300']),
    );
    const check = (origin?: string) => {
      let allowed: boolean | undefined;

      allowRequest(
        { headers: origin ? { origin } : {} } as IncomingMessage,
        (_, success) => {
          allowed = success;
        },
      );

      return allowed;
    };

    expect(check('http://localhost:4300')).toEqual(true);
    expect(check()).toEqual(true);
    expect(check('http://evil.example')).toEqual(false);
    expect(check('http://localhost:4300.evil.example')).toEqual(false);
  });
});
