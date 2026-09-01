// The assets the desk may hold and move, spelled out one by one. Nothing is
// inferred: an asset the desk can trade is in this table with its Obscura
// code and network, its chain, its contract and its decimals, and the
// deposit/withdrawal flags Obscura publishes for it. Anything not here is
// refused by the rails before a quote is even requested.
import { RPC_URL, ETH_RPC_URL, USDG_CONTRACT, OBS_CONTRACT, EXPLORER_URL } from "../config.ts";

export interface ChainSpec {
  key: string;
  id: number;
  name: string;
  rpc: string;
  explorerTx: (hash: string) => string;
  /** The public RPC in front of Robinhood Chain rejects default User-Agents. */
  browserUa: boolean;
}

export const CHAINS: Record<string, ChainSpec> = {
  ethereum: { key: "ethereum", id: 1, name: "Ethereum", rpc: ETH_RPC_URL, explorerTx: (h) => `https://etherscan.io/tx/${h}`, browserUa: false },
  robinhood: { key: "robinhood", id: 4663, name: "Robinhood Chain", rpc: RPC_URL, explorerTx: (h) => `${EXPLORER_URL}/tx/${h}`, browserUa: true },
  base: { key: "base", id: 8453, name: "Base", rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org", explorerTx: (h) => `https://basescan.org/tx/${h}`, browserUa: false },
};

export interface Asset {
  /** Book symbol, e.g. ETH. The same symbol on two chains shares a price. */
  symbol: string;
  /** Obscura's currency code and network, as GET /currencies lists them. */
  code: string;
  network: string;
  chain: string;
  kind: "native" | "erc20";
  contract: string | null;
  decimals: number;
  /** Obscura will accept this as the from-leg (deposit) / pay it out as the to-leg (withdrawal). */
  deposit: boolean;
  withdrawal: boolean;
}

/** Keyed by SYMBOL@network. */
export const ASSETS: Record<string, Asset> = {
  "ETH@eth": { symbol: "ETH", code: "eth", network: "eth", chain: "ethereum", kind: "native", contract: null, decimals: 18, deposit: true, withdrawal: true },
  "USDC@erc20": { symbol: "USDC", code: "usdc", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, deposit: true, withdrawal: true },
  "USDT@erc20": { symbol: "USDT", code: "usdt", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, deposit: true, withdrawal: true },
  "ETH@base": { symbol: "ETH", code: "eth", network: "base", chain: "base", kind: "native", contract: null, decimals: 18, deposit: false, withdrawal: true },
  "ETH@robinhood": { symbol: "ETH", code: "eth", network: "robinhood", chain: "robinhood", kind: "native", contract: null, decimals: 18, deposit: true, withdrawal: true },
  "USDG@robinhood": { symbol: "USDG", code: "usdg", network: "robinhood", chain: "robinhood", kind: "erc20", contract: USDG_CONTRACT, decimals: 6, deposit: true, withdrawal: true },
  "NVDA@robinhood": { symbol: "NVDA", code: "nvda", network: "robinhood", chain: "robinhood", kind: "erc20", contract: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", decimals: 18, deposit: true, withdrawal: true },
};

/** Assets the desk reads balances for even when it may not trade them. */
export const WATCHED_TOKENS: Array<{ symbol: string; chain: string; contract: string; decimals: number }> = [
  { symbol: "USDC", chain: "ethereum", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDT", chain: "ethereum", contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "USDG", chain: "robinhood", contract: USDG_CONTRACT, decimals: 6 },
  { symbol: "NVDA", chain: "robinhood", contract: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", decimals: 18 },
  { symbol: "OBS", chain: "robinhood", contract: OBS_CONTRACT, decimals: 18 },
];

/** Default network per symbol when a decision names only the symbol. */
const DEFAULT_NETWORK: Record<string, string> = { ETH: "eth", USDC: "erc20", USDT: "erc20", USDG: "robinhood", NVDA: "robinhood" };

/** PURE: "ETH", "ETH@robinhood", "usdg@robinhood" -> the registry entry, or null. */
export function resolveAsset(spec: string): Asset | null {
  const m = String(spec ?? "").trim().match(/^([A-Za-z0-9]+)(?:@([A-Za-z0-9-]+))?$/);
  if (!m) return null;
  const symbol = m[1].toUpperCase();
  const network = (m[2] ?? DEFAULT_NETWORK[symbol] ?? "").toLowerCase();
  return ASSETS[`${symbol}@${network}`] ?? null;
}
export const assetKey = (a: Asset) => `${a.symbol}@${a.network}`;
export const chainOf = (a: Asset): ChainSpec => CHAINS[a.chain];
