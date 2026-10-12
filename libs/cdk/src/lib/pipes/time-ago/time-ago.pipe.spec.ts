import { TimeAgoPipe } from './time-ago.pipe';

describe('TimeAgoPipe', () => {
  const pipe = new TimeAgoPipe();

  afterEach(() => {
    vi.useRealTimers();
  });

  function setNow(date: Date) {
    vi.useFakeTimers();
    vi.setSystemTime(date);
  }

  describe('within the same full year', () => {
    const now = new Date(2026, 9, 12, 12, 0, 0);

    beforeEach(() => {
      setNow(now);
    });

    it('returns Now for dates up to 60 seconds away', () => {
      expect(pipe.transform(now.getTime())).toBe('Now');
      expect(pipe.transform(now.getTime() - 30_000)).toBe('Now');
      expect(pipe.transform(now.getTime() - 60_000)).toBe('Now');
    });

    it('returns minutes ago', () => {
      expect(pipe.transform(now.getTime() - 61_000)).toBe('1 minute ago');
      expect(pipe.transform(now.getTime() - 5 * 60_000)).toBe('5 minutes ago');
      expect(pipe.transform(now.getTime() - 5 * 60_000 - 40_000)).toBe(
        '6 minutes ago',
      );
    });

    it('returns a singular hour', () => {
      expect(pipe.transform(now.getTime() - 60 * 60_000)).toBe('1 hour ago');
      expect(pipe.transform(now.getTime() - 89 * 60_000)).toBe('1 hour ago');
    });

    it('returns hours ago', () => {
      expect(pipe.transform(now.getTime() - 90 * 60_000)).toBe('2 hours ago');
      expect(pipe.transform(now.getTime() - 23 * 3_600_000)).toBe(
        '23 hours ago',
      );
    });

    it('returns days ago', () => {
      expect(pipe.transform(new Date(2026, 9, 11, 12).getTime())).toBe(
        '1 day ago',
      );
      expect(pipe.transform(new Date(2026, 9, 9, 8).getTime())).toBe(
        '3 days ago',
      );
      expect(pipe.transform(new Date(2026, 9, 5, 13).getTime())).toBe(
        '7 days ago',
      );
    });

    it('returns MMM d for dates more than 6 days away', () => {
      expect(pipe.transform(new Date(2026, 9, 5, 11).getTime())).toBe('Oct 5');
      expect(pipe.transform(new Date(2026, 0, 5, 9).getTime())).toBe('Jan 5');
    });
  });

  it('returns MMM d for the previous calendar year within a full year', () => {
    setNow(new Date(2026, 0, 5, 12));

    expect(pipe.transform(new Date(2025, 11, 20, 12).getTime())).toBe('Dec 20');
    expect(pipe.transform(new Date(2025, 0, 5, 12, 0, 1).getTime())).toBe(
      'Jan 5',
    );
  });

  it('returns MMM d, yyyy for dates at least one full year away', () => {
    setNow(new Date(2026, 0, 5, 12));

    expect(pipe.transform(new Date(2025, 0, 5, 12).getTime())).toBe(
      'Jan 5, 2025',
    );
    expect(pipe.transform(new Date(2024, 1, 29, 8).getTime())).toBe(
      'Feb 29, 2024',
    );
  });
});
