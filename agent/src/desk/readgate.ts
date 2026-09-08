// The reads' gate on a buy. A launch-token buy needs three reads from this
// same cycle, each completed and each passed: the tape's entry read, the
// holder read and the launch read. Pure, so the cycle's gate on the decision
// and the auto entry's pick judge a candidate the same way, and a refusal is
// the same sentence in both.
//
// A read that did not complete is a refusal that names it, never a pass.
// Until 2026-09-08 a holder read or a launch read that threw left no entry
// for its token, a transfer scan the RPC refused came back as a read of zero
// transfers, and a factory record that could not be read came back as "not
// a launch"; the gate took each for a pass, so an outage at the explorer,
// the RPC or the factory opened the door to a buy instead of closing it.
// Exits are never gated here. A token the desk already holds is judged as
// it was before that date: an add-on is refused on a read that failed, not
// on one that is missing.
import type { EntryRead } from "./entry.ts";
import type { HolderRead } from "./holders.ts";
import type { LaunchRead } from "./launch.ts";

export type ReadGate = { ok: true } | { ok: false; reason: string };

export interface ReadGateInput {
  symbol: string;
  /** The desk already holds the token, so this buy would be an add-on. */
  held: boolean;
  entry: Pick<EntryRead, "ok" | "why"> | null;
  holders: Pick<HolderRead, "ok" | "why" | "transfers"> | null;
  launch: Pick<LaunchRead, "exists" | "unread" | "verdict"> | null;
  /** Why a read threw this cycle, when one did: the refusal names it. */
  failed?: { holders?: string; launch?: string };
}

/** PURE: the holder read completed: it exists and saw transfers. A scan the RPC refused comes back with none. */
export function holderReadComplete<T extends Pick<HolderRead, "transfers">>(h: T | null | undefined): h is T {
  return !!h && h.transfers > 0;
}

/**
 * PURE: the launch read completed: it exists and the factory record was read. A token the factory does not know is
 * a completed read with nothing to say; a factory that did not answer is no read at all.
 */
export function launchReadComplete<T extends Pick<LaunchRead, "exists" | "unread">>(l: T | null | undefined): l is T {
  return !!l && (l.exists || !l.unread.includes("the factory record"));
}

const refuse = (reason: string): ReadGate => ({ ok: false, reason });

/** PURE: whether the reads allow this buy, and the reason when they do not. */
export function readsGate(i: ReadGateInput): ReadGate {
  // The tape: volume puts a token on watch, the price action gives the entry. Missing or failing, no buy, held or not.
  if (!i.entry) return refuse(`no tape was read for ${i.symbol} this cycle, so there is no entry read`);
  if (!i.entry.ok) return refuse(`the tape gives no entry: ${i.entry.why}`);
  if (i.held) {
    if (i.holders && i.holders.transfers > 0 && !i.holders.ok) return refuse(`the holders fail the read: ${i.holders.why}`);
    if (i.launch && !i.launch.verdict.ok) return refuse(`the launch fails the read: ${i.launch.verdict.why}`);
    return { ok: true };
  }
  if (!holderReadComplete(i.holders)) return refuse(`the holder read did not complete for ${i.symbol} (${i.failed?.holders ?? (i.holders ? "no transfers were read" : "it was not made this cycle")}), so there is no holder read`);
  if (!i.holders.ok) return refuse(`the holders fail the read: ${i.holders.why}`);
  if (!launchReadComplete(i.launch)) return refuse(`the launch read did not complete for ${i.symbol} (${i.failed?.launch ?? (i.launch ? "the factory record could not be read" : "it was not made this cycle")}), so there is no launch read`);
  if (!i.launch.verdict.ok) return refuse(`the launch fails the read: ${i.launch.verdict.why}`);
  return { ok: true };
}
