import type { Event } from 'socket.io';

// The web client batches board actions at ~15 Hz, so these limits only trip
// for clients flooding the socket.
export const WS_RATE_LIMIT = {
  perSecond: 30,
  burst: 60,
  // dropped events within the window before the socket is disconnected
  maxDropped: 120,
  windowMs: 10_000,
};

// Token bucket for the incoming events of one socket, used with socket.use().
// Events over the limit are dropped; sustained abuse calls onAbuse.
export function createWsRateLimiter(
  onAbuse: () => void,
  limit = WS_RATE_LIMIT,
  now = () => Date.now(),
) {
  let tokens = limit.burst;
  let last = now();
  let dropped = 0;
  let windowStart = last;

  return (_event: Event, next: (err?: Error) => void) => {
    const time = now();

    tokens = Math.min(
      limit.burst,
      tokens + ((time - last) / 1000) * limit.perSecond,
    );
    last = time;

    if (tokens >= 1) {
      tokens -= 1;
      next();

      return;
    }

    if (time - windowStart > limit.windowMs) {
      windowStart = time;
      dropped = 0;
    }

    dropped++;

    if (dropped > limit.maxDropped) {
      onAbuse();
    }
  };
}
