import { describe, expect, it } from 'vitest';
import { adherence, computeStreak, summarizeSeries } from '../src/modules/progress/progress.calc';
import { addDays, todayInTz } from '../src/lib/dates';

describe('computeStreak', () => {
  it('counts consecutive days ending today', () => {
    expect(computeStreak(['2026-11-08', '2026-11-09', '2026-11-10'], '2026-11-10')).toBe(3);
  });

  it('keeps the streak alive when today is not done yet', () => {
    expect(computeStreak(['2026-11-08', '2026-11-09'], '2026-11-10')).toBe(2);
  });

  it('breaks on a gap', () => {
    expect(computeStreak(['2026-11-06', '2026-11-08', '2026-11-09'], '2026-11-09')).toBe(2);
  });

  it('is 0 with no recent completions', () => {
    expect(computeStreak(['2026-11-01'], '2026-11-10')).toBe(0);
  });

  it('crosses month and year boundaries', () => {
    expect(computeStreak(['2025-12-31', '2026-01-01'], '2026-01-01')).toBe(2);
  });
});

describe('adherence', () => {
  it('returns null when nothing is due', () => expect(adherence(0, 0)).toBeNull());
  it('rounds to 3 decimals', () => expect(adherence(2, 3)).toBe(0.667));
});

describe('summarizeSeries', () => {
  it('computes change, min and max', () => {
    const s = summarizeSeries([
      { date: '2026-11-01', value: 80 },
      { date: '2026-11-05', value: 78.4 },
      { date: '2026-11-10', value: 77.9 },
    ]);
    expect(s).toMatchObject({ change: -2.1, min: 77.9, max: 80 });
  });
  it('returns null for empty series', () => expect(summarizeSeries([])).toBeNull());
});

describe('dates', () => {
  it('adds days across DST-free UTC math', () => expect(addDays('2026-02-28', 1)).toBe('2026-03-01'));
  it('resolves today in the org timezone', () => {
    // 2026-11-10 20:00 UTC is already 2026-11-11 in Vietnam (UTC+7)
    expect(todayInTz('Asia/Ho_Chi_Minh', new Date('2026-11-10T20:00:00Z'))).toBe('2026-11-11');
  });
});
