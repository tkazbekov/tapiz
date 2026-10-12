import { createHash, randomBytes } from 'node:crypto';

// 32 random bytes, base64url: always 43 characters
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && tokenPattern.test(token);
}

// Only this hash is stored, for sessions, reset and verification links.
export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
