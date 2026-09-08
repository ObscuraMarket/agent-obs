import { agentsSummary, shortPct, sinceText, sinceTitle, visibleAgents, wholeUsd } from './agents';

const row = (p: Partial<{ on: boolean; mode: 'paper' | 'live'; trades: number; positions: unknown[]; walletAddress: string }> = {}) =>
  ({ on: true, mode: 'live' as const, trades: 0, positions: [], ...p });

describe('the public Agents table', () => {
  it('hides an agent that is off with no trades and nothing held, and keeps every other one', () => {
    const off = row({ on: false });
    const offTraded = row({ on: false, trades: 2 });
    const offHolding = row({ on: false, positions: [{ asset: 'PORT' }] });
    const on = row();
    expect(visibleAgents([off, offTraded, offHolding, on])).toEqual([offTraded, offHolding, on]);
    expect(visibleAgents([])).toEqual([]);
  });

  it('keeps the row of a hidden agent while a deep link has its panel open', () => {
    const off = row({ on: false, walletAddress: '0xABC' });
    const on = row({ walletAddress: '0xDEF' });
    expect(visibleAgents([off, on], '0xabc')).toEqual([off, on]);
    expect(visibleAgents([off, on], '0x999')).toEqual([on]);
    expect(visibleAgents([off, on], null)).toEqual([on]);
  });

  it('sums the visible rows, and only mentions mode when a paper agent shows', () => {
    expect(agentsSummary([])).toBe('none yet');
    expect(agentsSummary([row(), row(), row(), row({ on: false, trades: 1 })])).toBe('3 running · 4 agents');
    expect(agentsSummary([row({ mode: 'paper' })])).toBe('1 running · 1 agent · 1 on paper');
    expect(agentsSummary([row(), row({ on: false, trades: 1, mode: 'paper' })])).toBe('1 running · 2 agents · 1 on paper');
  });

  it('says since in minutes, then hours, then the day', () => {
    const now = Date.UTC(2026, 8, 8, 12, 0, 0);
    expect(sinceText(now, now)).toBe('just now');
    expect(sinceText(now - 20_000, now)).toBe('just now');
    expect(sinceText(now - 35 * 60_000, now)).toBe('35m ago');
    expect(sinceText(now - 59.6 * 60_000, now)).toBe('1h ago');
    expect(sinceText(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(sinceText(now - 23 * 3_600_000, now)).toBe('23h ago');
    expect(sinceText(now - (23 * 60 + 31) * 60_000, now)).toBe('24h ago');
    expect(sinceText(now - 24 * 3_600_000, now)).toBe('Sep 7');
    expect(sinceText(Date.UTC(2026, 8, 7, 9, 30, 0), now)).toBe('Sep 7');
    expect(sinceText(Date.UTC(2025, 11, 31, 9, 30, 0), now)).toBe('Dec 31, 2025');
    expect(sinceText(now + 60_000, now)).toBe('just now');
  });

  it('carries the full UTC moment for the title', () => {
    expect(sinceTitle(Date.UTC(2026, 8, 7, 9, 3, 5))).toBe('2026-09-07 09:03:05 UTC');
  });

  it('reads a holding as whole dollars and one decimal of percent', () => {
    expect(wholeUsd(94.44)).toBe('$94');
    expect(wholeUsd(1234.5)).toBe('$1,235');
    expect(wholeUsd(0.4)).toBe('$0');
    expect(wholeUsd(-0.4)).toBe('$0');
    expect(wholeUsd(-12.6)).toBe('-$13');
    expect(wholeUsd(NaN)).toBe('n/a');
    expect(wholeUsd(null)).toBe('n/a');
    expect(shortPct(-0.0556)).toBe('-5.6%');
    expect(shortPct(0.12)).toBe('+12.0%');
    expect(shortPct(0)).toBe('0.0%');
    expect(shortPct(-0.0004)).toBe('0.0%');
    expect(shortPct(NaN)).toBe('');
    expect(shortPct(undefined)).toBe('');
  });
});
