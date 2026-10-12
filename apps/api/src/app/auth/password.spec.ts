import {
  PasswordHasherBusyError,
  createHashLimiter,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

describe('password', () => {
  it('verifies the password it hashed', async () => {
    const hash = await hashPassword('correct horse');

    expect(hash).toMatch(/^scrypt\$15\$8\$3\$[\w-]+\$[\w-]+$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', hash)).toEqual(true);
    expect(await verifyPassword('correct horsE', hash)).toEqual(false);
  });

  it('uses a new salt every time', async () => {
    expect(await hashPassword('same')).not.toEqual(await hashPassword('same'));
  });

  it('normalises unicode before hashing', async () => {
    const hash = await hashPassword('café au lait');

    expect(await verifyPassword('café au lait', hash)).toEqual(true);
  });

  it('rejects missing or garbled hashes without throwing', async () => {
    for (const stored of [
      null,
      '',
      'nope',
      'scrypt$15$8$3$salt',
      'scrypt$99$8$3$c2FsdHNhbHRzYWx0c2FsdA$a2V5',
      'bcrypt$15$8$3$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5',
    ]) {
      expect(await verifyPassword('anything', stored)).toEqual(false);
    }
  });

  it('flags hashes with other parameters for rehashing', async () => {
    const hash = await hashPassword('pw');
    const [, , , , salt, key] = hash.split('$');

    expect(needsRehash(hash)).toEqual(false);
    expect(needsRehash(`scrypt$14$8$1$${salt}$${key}`)).toEqual(true);
    expect(needsRehash('garbled')).toEqual(true);
  });

  it('verifies hashes made with other parameters', async () => {
    const hash = await hashPassword('pw');
    const [, , , , salt] = hash.split('$');
    const weaker = `scrypt$14$8$1$${salt}$${'A'.repeat(86)}`;

    // well-formed, just not matching
    expect(await verifyPassword('pw', weaker)).toEqual(false);
  });

  it('runs a bounded number of hashes and turns away the overflow', async () => {
    const limit = createHashLimiter(2, 1);
    const releases: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
      });

    const running = [task(), task(), task()];

    await expect(task()).rejects.toBeInstanceOf(PasswordHasherBusyError);

    // two run, the third waits
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[1]();
    releases[2]();

    await Promise.all(running);

    expect(maxActive).toEqual(2);
    await expect(limit(async () => 'free again')).resolves.toEqual(
      'free again',
    );
  });
});
