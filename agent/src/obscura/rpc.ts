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

// The public endpoint limits bursts, so consecutive calls to one host are
// spaced out. A burst limit (429) clears in seconds and gets one patient
// retry; a challenge page (403) does not, and that host is left alone.
const MIN_GAP_MS = 400;
const nextSlot = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pace(url: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(url) ?? 0);
  nextSlot.set(url, slot + MIN_GAP_MS);
  if (slot > now) await sleep(slot - now);
}

export async function rpc(url: string, method: string, params: unknown[]): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (rpcBlocked(url)) return null;
    await pace(url);
    let limited = false;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 403) {
        blockedUntil.set(url, Date.now() + RPC_COOLDOWN_MS);
        return null;
      }
      if (res.status === 429) limited = true;
      else {
        const j = (await res.json()) as { result?: string; error?: { code?: number } };
        if (typeof j.result === "string") return j.result;
        if (j.error?.code === 429) limited = true;
      }
    } catch {
      /* fall through to the retry */
    }
    if (limited && attempt === 2) {
      blockedUntil.set(url, Date.now() + RPC_COOLDOWN_MS);
      return null;
    }
    await sleep(limited ? 2500 : 600);
  }
  return null;
}

/** eth_call against Robinhood Chain unless another chain's URL is given. */
export const ethCall = (to: string, data: string, url = RPC_URL) => rpc(url, "eth_call", [{ to, data }, "latest"]);
