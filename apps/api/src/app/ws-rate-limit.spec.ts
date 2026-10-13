import type { Event } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
import { createWsRateLimiter } from './ws-rate-limit';

const limit = { perSecond: 10, burst: 5, maxDropped: 3, windowMs: 1000 };
const event = ['board', {}] as Event;

function setup() {
  let time = 0;
  const onAbuse = vi.fn();
  const limiter = createWsRateLimiter(onAbuse, limit, () => time);

  const send = (count: number) => {
    const next = vi.fn();

    for (let i = 0; i < count; i++) {
      limiter(event, next);
    }

    return next.mock.calls.length;
  };

  return {
    send,
    onAbuse,
    advance: (ms: number) => (time += ms),
  };
}

describe('createWsRateLimiter', () => {
  it('lets a burst through and drops the rest', () => {
    const { send, onAbuse } = setup();

    expect(send(7)).toBe(5);
    expect(onAbuse).not.toHaveBeenCalled();
  });

  it('refills over time', () => {
    const { send, advance } = setup();

    send(5);
    advance(300);

    expect(send(5)).toBe(3);
  });

  it('reports sustained flooding', () => {
    const { send, onAbuse } = setup();

    send(5 + limit.maxDropped);
    expect(onAbuse).not.toHaveBeenCalled();

    send(1);
    expect(onAbuse).toHaveBeenCalledTimes(1);
  });

  it('forgets drops from an earlier window', () => {
    const { send, onAbuse, advance } = setup();

    send(5 + limit.maxDropped);
    advance(limit.windowMs + 1);
    // the bucket refilled, so drain it again before counting drops
    send(5 + limit.maxDropped);

    expect(onAbuse).not.toHaveBeenCalled();
  });
});
