/**
 * The public Agents table's pure helpers: which agents show, what the card's summary says, and how a row's
 * numbers read. Kept out of the component so a unit spec can hold them still. Until 2026-09-08 the table listed
 * every agent the API returned (an off "test" agent with no trades and nothing held among them), showed Since as
 * a bare clock time with seconds and read "3 on, 3 live, 4 all time" across eight columns; the operator asked for
 * a calmer section.
 */

export interface AgentRow {
  on: boolean;
  mode: 'paper' | 'live';
  trades: number;
  positions: Array<unknown>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** PURE: an agent earns a row while it runs, or once it has traded or holds something; a switched-off blank does not. */
export function visibleAgents<T extends AgentRow>(agents: T[]): T[] {
  return agents.filter((a) => a.on || a.trades > 0 || a.positions.length > 0);
}

/**
 * PURE: the card's summary from the rows that show: "3 running · 4 agents". Live is the norm, so mode is only
 * mentioned when a paper agent is among them: "· 1 on paper".
 */
export function agentsSummary(visible: AgentRow[]): string {
  if (!visible.length) { return 'none yet'; }
  const running = visible.filter((a) => a.on).length;
  const paper = visible.filter((a) => a.mode === 'paper').length;
  const agents = `${visible.length} ${visible.length === 1 ? 'agent' : 'agents'}`;
  return `${running} running · ${agents}` + (paper ? ` · ${paper} on paper` : '');
}

/**
 * PURE: how long ago an agent started, short: "just now", "35 min ago", "2 h ago", then the day ("Sep 7", with
 * the year once it is not this year). `now` is a parameter so a spec can hold the clock.
 */
export function sinceText(ts: number, now: number = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) { return 'just now'; }
  if (m < 60) { return `${m} min ago`; }
  const h = Math.round(m / 60);
  if (h < 24) { return `${h} h ago`; }
  const d = new Date(ts), n = new Date(now);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return d.getUTCFullYear() === n.getUTCFullYear() ? day : `${day}, ${d.getUTCFullYear()}`;
}

/** PURE: the full moment behind the short form, UTC like every other clock on the page, for a title attribute. */
export function sinceTitle(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/** PURE: whole dollars for a holding's value: 94.44 reads "$94", 1234.5 reads "$1,235". */
export function wholeUsd(v: number): string {
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
}

/** PURE: a signed percent with one decimal from a fraction: -0.0556 reads "-5.6%", 0.12 reads "+12.0%". */
export function shortPct(v: number): string {
  return (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
}
