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
  "DAI@erc20": { symbol: "DAI", code: "dai", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, deposit: true, withdrawal: true },
  // The high-volume majors Obscura routes on Ethereum, each verified on chain (symbol, decimals) on 2026-09-02.
  "WBTC@erc20": { symbol: "WBTC", code: "wbtc", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, deposit: true, withdrawal: true },
  "LINK@erc20": { symbol: "LINK", code: "link", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, deposit: true, withdrawal: true },
  "UNI@erc20": { symbol: "UNI", code: "uni", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, deposit: true, withdrawal: true },
  "AAVE@erc20": { symbol: "AAVE", code: "aave", network: "erc20", chain: "ethereum", kind: "erc20", contract: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18, deposit: true, withdrawal: true },
  "ETH@base": { symbol: "ETH", code: "eth", network: "base", chain: "base", kind: "native", contract: null, decimals: 18, deposit: false, withdrawal: true },
  "ETH@robinhood": { symbol: "ETH", code: "eth", network: "robinhood", chain: "robinhood", kind: "native", contract: null, decimals: 18, deposit: true, withdrawal: true },
  "USDG@robinhood": { symbol: "USDG", code: "usdg", network: "robinhood", chain: "robinhood", kind: "erc20", contract: USDG_CONTRACT, decimals: 6, deposit: true, withdrawal: true },
  "NVDA@robinhood": { symbol: "NVDA", code: "nvda", network: "robinhood", chain: "robinhood", kind: "erc20", contract: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", decimals: 18, deposit: true, withdrawal: true },
};

/** Assets the desk reads balances for even when it may not trade them. */
export const WATCHED_TOKENS: Array<{ symbol: string; chain: string; contract: string; decimals: number }> = [
  { symbol: "USDC", chain: "ethereum", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDT", chain: "ethereum", contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "DAI", chain: "ethereum", contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  { symbol: "WBTC", chain: "ethereum", contract: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  { symbol: "LINK", chain: "ethereum", contract: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  { symbol: "UNI", chain: "ethereum", contract: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  { symbol: "AAVE", chain: "ethereum", contract: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 },
  { symbol: "USDG", chain: "robinhood", contract: USDG_CONTRACT, decimals: 6 },
  { symbol: "NVDA", chain: "robinhood", contract: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", decimals: 18 },
  { symbol: "OBS", chain: "robinhood", contract: OBS_CONTRACT, decimals: 18 },
];

/** Default network per symbol when a decision names only the symbol. */
const DEFAULT_NETWORK: Record<string, string> = { ETH: "eth", USDC: "erc20", USDT: "erc20", DAI: "erc20", WBTC: "erc20", LINK: "erc20", UNI: "erc20", AAVE: "erc20", USDG: "robinhood", NVDA: "robinhood" };

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
