// One door to the chains OBS reads. The public RPC in front of Robinhood
// Chain sits behind Cloudflare: it rejects default User-Agents, answers a bot
// challenge (403) or 429 after a burst, and hands back one error object
// instead of an array for an oversized JSON-RPC batch. So every call carries
// a browser UA, callers make Robinhood reads one at a time, and a host that
// has just refused is left alone for five minutes instead of hammered. Null
// always means "not read this cycle", never zero.
import { RPC_URL } from "../config.ts";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const blockedUntil = new Map<string, number>();
const RPC_COOLDOWN_MS = 5 * 60_000;
export function rpcBlocked(url: string): boolean {
  return (blockedUntil.get(url) ?? 0) > Date.now();
}

export async function rpc(url: string, method: string, params: unknown[]): Promise<string | null> {
  if (rpcBlocked(url)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403 || res.status === 429) {
        blockedUntil.set(url, Date.now() + RPC_COOLDOWN_MS);
        return null;
      }
      const j = (await res.json()) as { result?: string };
      if (typeof j.result === "string") return j.result;
    } catch {
      /* fall through to the retry */
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/** eth_call against Robinhood Chain unless another chain's URL is given. */
export const ethCall = (to: string, data: string, url = RPC_URL) => rpc(url, "eth_call", [{ to, data }, "latest"]);
