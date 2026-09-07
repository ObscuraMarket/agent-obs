// The judgement behind `npm run obscura:verify`: for one pair, how the routing backend, the app's Relay route and
// the pools answer, said as lines a person can act on. Pure: the runner (scripts/verifyObscura.ts) gathers the
// answers, this file compares them. The pools are the reference: they are where every Robinhood Chain swap
// settles, whichever door it came through, so a route that pays much less than the pool is losing the user money
// somewhere between the two.

export interface BackendAnswer {
  status: number;
  count: number;
  partner: string | null;
  toAmount: number | null;
  min: number | null;
  max: number | null;
  error: string | null;
}

export interface RelayAnswerSummary {
  status: number;
  toAmount: number | null;
  impactPct: number | null;
  feeUsd: number | null;
  error: string | null;
}

export interface PoolAnswer {
  toAmount: number;
  costPct: number | null;
}

export type AppRoute = "relay" | "backend";

export interface PairCheck {
  pair: string;
  from: string;
  to: string;
  amount: number;
  backend: BackendAnswer;
  /** Null when Relay was not asked (no Robinhood Chain leg). */
  relay: RelayAnswerSummary | null;
  /** Null when the pair is not two Robinhood Chain assets the desk can route through the pools. */
  pool: PoolAnswer | null;
  /** The door the app would show for this pair. */
  appRoute: AppRoute;
}

/**
 * PURE: what the partner behind the backend's "cex pool" lists on Robinhood Chain that the backend does not offer.
 * The partner's list is the ceiling of what the backend could route there; every code missing from the backend's
 * own list is a pair the backend answers with a crash instead of a quote.
 */
export function missingFromBackend(partnerCodes: Iterable<string>, backendCodes: Iterable<string>): string[] {
  const have = new Set([...backendCodes].map((c) => c.toLowerCase()));
  return [...new Set([...partnerCodes].map((c) => c.toLowerCase()))].filter((c) => !have.has(c)).sort();
}

/** PURE: percent by which x differs from the reference; null when either is missing. */
export function spreadPct(x: number | null, ref: number | null): number | null {
  if (x == null || ref == null || !(ref > 0)) return null;
  return ((x - ref) / ref) * 100;
}

/** PURE: what the backend's status and count amount to. */
export function backendState(b: BackendAnswer): "quoted" | "empty" | "server error" | "client error" | "unreachable" {
  if (b.status === 0) return "unreachable";
  if (b.status >= 500) return "server error";
  if (b.status >= 400) return "client error";
  return b.count > 0 ? "quoted" : "empty";
}

/**
 * PURE: the door the app shows, from its own rule (swap.component.ts, robinhoodCexPair): a pair with a Robinhood
 * Chain leg is Relay only while every Robinhood Chain leg is ETH or USDG, the two Relay bridges natively; any other
 * token on that chain (NVDA, cashcat) is a partner's to settle, so the backend's quote shows and Relay is
 * suppressed. Off Robinhood Chain the backend's partners are the route and Relay is a fallback.
 */
export function appRouteFor(from: { code: string; network: string }, to: { code: string; network: string }): AppRoute {
  const legs = [from, to].filter((a) => a.network === "robinhood");
  if (!legs.length) return "backend";
  return legs.every((a) => ["eth", "usdg"].includes(a.code.toLowerCase())) ? "relay" : "backend";
}

const pct = (v: number | null): string => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const amt = (v: number | null): string => (v == null ? "n/a" : v >= 1000 ? v.toFixed(2) : v.toPrecision(6));

/** PURE: one line per pair, aligned, for the terminal. */
export function tableLines(checks: PairCheck[]): string[] {
  const rows = checks.map((c) => {
    const state = backendState(c.backend);
    const backend = state === "quoted" ? `${c.backend.partner} ${amt(c.backend.toAmount)} (${pct(spreadPct(c.backend.toAmount, c.pool?.toAmount ?? null))})` : `${state}${c.backend.status ? ` ${c.backend.status}` : ""}`;
    const relay = c.relay == null ? "not asked" : c.relay.toAmount != null ? `${amt(c.relay.toAmount)} (${pct(spreadPct(c.relay.toAmount, c.pool?.toAmount ?? null))})` : (c.relay.error ?? "no quote");
    const pool = c.pool ? amt(c.pool.toAmount) : "no route";
    return [`${c.amount} ${c.pair}`, `app: ${c.appRoute}`, `backend: ${backend}`, `relay: ${relay}`, `pool: ${pool}`];
  });
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}

/** PURE: what is wrong and what is right, one line each, the problems first. */
export function verdicts(checks: PairCheck[]): string[] {
  const bad: string[] = [];
  const good: string[] = [];
  for (const c of checks) {
    const state = backendState(c.backend);
    const ref = c.pool?.toAmount ?? null;
    if (state === "server error") {
      bad.push(`BACKEND ${c.pair}: HTTP ${c.backend.status}. ${c.appRoute === "relay" ? "The app never asks the backend for this pair (it shows Relay), so users do not see it, but the desk's own watchlist asks every cycle and any integrator would too. An unknown pair should be an empty list, not a crash." : "The app shows this pair through the backend, so users see no route while this lasts."}`);
    } else if (state === "unreachable") {
      bad.push(`BACKEND ${c.pair}: not reachable (${c.backend.error ?? "no answer"}).`);
    } else if (state === "client error") {
      bad.push(`BACKEND ${c.pair}: HTTP ${c.backend.status} (${c.backend.error ?? "refused"}).`);
    } else if (state === "empty") {
      (c.appRoute === "backend" ? bad : good).push(`BACKEND ${c.pair}: no partner quotes it${c.appRoute === "backend" ? ", and the app shows this pair through the backend, so users see no route" : ", which is fine: the app shows Relay for it"}.`);
    } else {
      const s = spreadPct(c.backend.toAmount, ref);
      if (s != null && s < -3) bad.push(`BACKEND ${c.pair}: ${c.backend.partner} pays ${pct(s)} against the pool (${amt(c.backend.toAmount)} vs ${amt(ref)}).${c.appRoute === "backend" ? " This is the route users get." : ""}`);
      else if (s != null) good.push(`BACKEND ${c.pair}: ${c.backend.partner} quotes within ${pct(s)} of the pool.`);
      else good.push(`BACKEND ${c.pair}: ${c.backend.partner} quotes ${amt(c.backend.toAmount)} (no pool reference for this pair).`);
      if (c.backend.min != null && c.backend.min > c.amount) bad.push(`BACKEND ${c.pair}: the partner's minimum is ${c.backend.min}, above the ${c.amount} asked; the quote could not be ordered at this size.`);
    }
    if (c.relay) {
      if (c.relay.toAmount != null) {
        const s = spreadPct(c.relay.toAmount, ref);
        if (s != null && s < -1) bad.push(`RELAY ${c.pair}: pays ${pct(s)} against the pool (${amt(c.relay.toAmount)} vs ${amt(ref)}).${c.appRoute === "relay" ? " This is the route users get." : ""}`);
        else good.push(`RELAY ${c.pair}: ${s != null ? `within ${pct(s)} of the pool` : `quotes ${amt(c.relay.toAmount)}`}${c.relay.feeUsd != null ? `, fees $${c.relay.feeUsd.toFixed(2)}` : ""}.${c.appRoute === "relay" ? " This is the route users get." : ""}`);
      } else {
        (c.appRoute === "relay" ? bad : good).push(`RELAY ${c.pair}: ${c.relay.error ?? "no quote"}${c.appRoute === "relay" ? ". The app shows Relay for this pair, so users see no route" : ". Fine: the app shows the backend's partner for it"}.`);
      }
    }
    if (!c.pool && c.from.endsWith("@robinhood") && c.to.endsWith("@robinhood")) bad.push(`POOL ${c.pair}: the desk found no pool route, so there is no reference for this pair.`);
  }
  return [...bad, ...good];
}
