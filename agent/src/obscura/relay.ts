// Relay (relay.link) is the route the app calls "Private route": the one it uses for ETH and USDG on Robinhood
// Chain, where the routing backend's partners do not settle. It is intent-based: the user's own wallet signs the
// steps Relay hands back; there is no deposit address and no order record. This client quotes exactly the way the
// app does (the site's relay.service.ts), so the desk can hold the app's route up against the pools. Nothing here
// signs or sends.
import type { Asset } from "../desk/assets.ts";

export const RELAY_API = "https://api.relay.link";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** The app's network code to EVM chain id map, the part of it the desk's registry can name. Robinhood Chain is 4663. */
export const RELAY_CHAIN: Record<string, number> = { eth: 1, ethereum: 1, erc20: 1, base: 8453, arbitrum: 42161, robinhood: 4663 };

export function relayChainId(network: string): number | null {
  return RELAY_CHAIN[(network ?? "").toLowerCase()] ?? null;
}

/** PURE: a whole-unit amount in the token's smallest unit, as a decimal string, without float error. */
export function toSmallest(amount: number, decimals: number): string {
  const text = String(amount).includes("e") ? amount.toFixed(decimals) : String(amount);
  const [i, f = ""] = text.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return ((i.replace(/^0+/, "") || "0") + frac).replace(/^0+/, "") || "0";
}

export interface RelayBody {
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: "EXACT_INPUT";
}

/** PURE: the quote request the app sends, or null when a leg is on a chain Relay is not asked about. */
export function relayBody(from: Asset, to: Asset, amount: number, user: string): RelayBody | null {
  const o = relayChainId(from.network);
  const d = relayChainId(to.network);
  if (o == null || d == null || !(amount > 0)) return null;
  return { user, recipient: user, originChainId: o, destinationChainId: d, originCurrency: from.contract ?? NATIVE, destinationCurrency: to.contract ?? NATIVE, amount: toSmallest(amount, from.decimals), tradeType: "EXACT_INPUT" };
}

export interface RelayStep {
  id: string;
  kind: string;
  /** The transactions the step asks the wallet to send, calldata included: this is what the desk puts in its batch. */
  txs: Array<{ to: string; value: string; chainId: number | null; data: string }>;
}

export interface RelayQuote {
  amountIn: number;
  amountInUsd: number | null;
  amountOut: number;
  amountOutUsd: number | null;
  rate: number | null;
  /** Relay's own total impact, percent, negative when the user loses to the mark. */
  impactPct: number | null;
  /** Gas plus the relayer's fee, dollars. */
  feeUsd: number | null;
  timeSec: number | null;
  steps: RelayStep[];
  raw: Record<string, unknown>;
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** PURE: Relay's reply as the desk reads it, or null when it carries no output amount. */
export function parseRelayQuote(json: unknown): RelayQuote | null {
  const d = json as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  const details = (d.details ?? {}) as Record<string, unknown>;
  const cin = (details.currencyIn ?? {}) as Record<string, unknown>;
  const cout = (details.currencyOut ?? {}) as Record<string, unknown>;
  const amountOut = num(cout.amountFormatted ?? cout.amount);
  if (amountOut == null || amountOut <= 0) return null;
  const fees = (d.fees ?? {}) as Record<string, Record<string, unknown>>;
  const feeUsd = ["gas", "relayer"].map((k) => num(fees[k]?.amountUsd)).filter((v): v is number => v != null);
  const impact = details.totalImpact as Record<string, unknown> | undefined;
  const steps: RelayStep[] = (Array.isArray(d.steps) ? d.steps : []).map((s: Record<string, unknown>) => ({
    id: String(s.id ?? ""),
    kind: String(s.kind ?? ""),
    txs: (Array.isArray(s.items) ? s.items : []).map((it: Record<string, unknown>) => {
      const tx = (it.data ?? {}) as Record<string, unknown>;
      return { to: String(tx.to ?? ""), value: String(tx.value ?? "0"), chainId: num(tx.chainId), data: String(tx.data ?? "0x") };
    }),
  }));
  return {
    amountIn: num(cin.amountFormatted ?? cin.amount) ?? 0,
    amountInUsd: num(cin.amountUsd),
    amountOut,
    amountOutUsd: num(cout.amountUsd),
    rate: num(details.rate),
    impactPct: impact && typeof impact === "object" ? num(impact.percent) : null,
    feeUsd: feeUsd.length ? feeUsd.reduce((a, b) => a + b, 0) : null,
    timeSec: num(details.timeEstimate),
    steps,
    raw: d,
  };
}

export interface RelayAnswer {
  status: number;
  quote: RelayQuote | null;
  /** Relay's own words when it refuses: "UNSUPPORTED_CURRENCY: Unsupported currency". */
  error: string | null;
}

/** The app's quote for a pair, with the reason when there is none. Never throws. */
export async function relayQuote(from: Asset, to: Asset, amount: number, user: string, fetchFn: typeof fetch = fetch): Promise<RelayAnswer> {
  const body = relayBody(from, to, amount, user);
  if (!body) return { status: 0, quote: null, error: "a leg is on a chain Relay is not asked about" };
  try {
    const res = await fetchFn(`${RELAY_API}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = (json ?? {}) as Record<string, unknown>;
      return { status: res.status, quote: null, error: [e.errorCode, e.message].filter(Boolean).join(": ") || `HTTP ${res.status}` };
    }
    const quote = parseRelayQuote(json);
    return { status: res.status, quote, error: quote ? null : "no output amount in the reply" };
  } catch (e) {
    return { status: 0, quote: null, error: e instanceof Error ? e.message : String(e) };
  }
}
