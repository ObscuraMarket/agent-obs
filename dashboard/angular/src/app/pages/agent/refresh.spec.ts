import { REFRESH_MAX_MS, REFRESH_MS, nextRefreshMs } from './refresh';

describe('the polling clock', () => {
  it('goes back to fifteen seconds on a success, from any wait', () => {
    expect(nextRefreshMs(REFRESH_MS, null)).toBe(REFRESH_MS);
    expect(nextRefreshMs(120_000, null)).toBe(REFRESH_MS);
    expect(nextRefreshMs(REFRESH_MAX_MS, null)).toBe(REFRESH_MS);
  });

  it('doubles on a 429 until a success, and never past five minutes', () => {
    let ms = REFRESH_MS;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { ms = nextRefreshMs(ms, 429); seen.push(ms); }
    expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, REFRESH_MAX_MS, REFRESH_MAX_MS]);
  });

  it('keeps the wait on any other failure', () => {
    expect(nextRefreshMs(60_000, 502)).toBe(60_000);
    expect(nextRefreshMs(REFRESH_MS, 0)).toBe(REFRESH_MS);
  });
});
