// One chat turn's bookkeeping, kept pure so the stream route in server.ts stays a thin effect around it: when the
// turn's slot goes back, and what the turn is metered on when it stops early.
//
// Two things went wrong on the stream route until 2026-09-08. A client that closed the socket mid-reply paid
// nothing, because the charge only ran after a finished stream. And a request refused before the guard admitted it
// (a body too large, bad JSON, an empty message, a closed door) still gave a slot back on the way out, which
// cleared another turn's in-flight mark and decremented the shared slot count for everyone.

export interface TurnState {
  /** chatGuard admitted the turn: the wallet is marked in flight and a shared slot is held. */
  guarded: boolean;
  /** The slot has already gone back for this request. */
  ended: boolean;
}

/** PURE: does this request hold a slot it has not yet given back. A refusal before the guard holds none; a turn
 *  admitted and then refused, failed or finished holds one, once. */
export function shouldEndTurn(t: TurnState): boolean {
  return t.guarded && !t.ended;
}

export interface StreamTally {
  /** Events the gateway sent back, of any kind: proof it took the message and did work on it. */
  delivered: number;
  /** The text of the final frame, empty when the turn stopped before one. */
  final: string;
  /** The deltas joined in order: what the person had seen when the turn stopped early. */
  streamed: string;
}

/** PURE: the reply text a turn is metered on, or null when nothing is owed. Nothing came back, so nothing is owed:
 *  the gateway was unreachable or refused the call, and a person does not pay for a failure with nothing to show.
 *  Otherwise the longer of the final text and the streamed deltas: the final when the stream finished, the deltas
 *  when the socket closed or the idle timer fired first, and the deltas again when a turn answered twice around a
 *  tool call and the last final covers only the second answer. An empty string is still a charge: the prompt was
 *  read even when no text came back. */
export function meteredReply(t: StreamTally): string | null {
  if (t.delivered <= 0) return null;
  return t.final.length >= t.streamed.length ? t.final : t.streamed;
}
