import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}

// About 32 MiB and ~100 ms per hash (OWASP-equivalent scrypt settings).
const CURRENT: ScryptParams = { logN: 15, r: 8, p: 3 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Hashes share the 4-thread libuv pool with sharp, fs and dns, so only a few
// run at once and a burst beyond the queue is turned away.
const MAX_ACTIVE_HASHES = 2;
const MAX_QUEUED_HASHES = 50;

// Unknown emails and accounts without a password hash against this salt so
// they take as long as a real check.
const dummySalt = randomBytes(SALT_LENGTH);

export class PasswordHasherBusyError extends Error {
  constructor() {
    super('Too many password hashes in progress');
  }
}

export function createHashLimiter(maxActive: number, maxQueued: number) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active < maxActive) {
      active++;
    } else if (queue.length < maxQueued) {
      // the finishing task hands its slot over without decrementing
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      throw new PasswordHasherBusyError();
    }

    try {
      return await task();
    } finally {
      const next = queue.shift();

      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

const limitHashes = createHashLimiter(MAX_ACTIVE_HASHES, MAX_QUEUED_HASHES);

// Written by hand: promisify(scrypt) drops the options argument from its
// types, and Node's default maxmem (32 MiB) is too small for these params.
function deriveKey(
  password: string,
  salt: Buffer,
  { logN, r, p }: ScryptParams,
  keyLength: number,
) {
  const N = 2 ** logN;

  return limitHashes(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password.normalize('NFC'),
          salt,
          keyLength,
          { N, r, p, maxmem: 256 * N * r },
          (err, key) => (err ? reject(err) : resolve(key)),
        );
      }),
  );
}

function parseHash(stored: string) {
  const parts = stored.split('$');

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const [logN, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');

  const valid =
    Number.isInteger(logN) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    logN >= 10 &&
    logN <= 20 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16 &&
    salt.length >= SALT_LENGTH &&
    key.length >= 32;

  return valid ? { params: { logN, r, p }, salt, key } : null;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, CURRENT, KEY_LENGTH);
  const { logN, r, p } = CURRENT;

  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Always runs scrypt, also when there is no usable hash, so the timing does
// not tell whether an account exists.
export async function verifyPassword(password: string, stored: string | null) {
  const parsed = stored ? parseHash(stored) : null;

  if (!parsed) {
    await deriveKey(password, dummySalt, CURRENT, KEY_LENGTH);

    return false;
  }

  const key = await deriveKey(
    password,
    parsed.salt,
    parsed.params,
    parsed.key.length,
  );

  return timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string) {
  const parsed = parseHash(stored);

  return (
    !parsed ||
    parsed.params.logN !== CURRENT.logN ||
    parsed.params.r !== CURRENT.r ||
    parsed.params.p !== CURRENT.p ||
    parsed.key.length !== KEY_LENGTH
  );
}
