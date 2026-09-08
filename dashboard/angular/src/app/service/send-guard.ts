// What the console puts in front of a wallet to sign, judged before the wallet opens. The desk hands the page
// ready-made transactions (a swap's steps, a credits payment, a funding of the agent's wallet). Until 2026-09-08
// the page signed whatever came back, on whatever chain, to whatever address. Now every one is held up against the
// chain the console lives on and a short list of destinations, and where it goes is printed before the wallet sees
// it. Pure on purpose: no Angular, no window, so the desk's own tests run it (agent/test/sendGuard.test.ts).

/** Robinhood Chain, and the two contracts every console swap goes through (agent/obs-chain.json, verified 2026-09-01). */
export const ROBINHOOD_CHAIN_ID = 4663;
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';

/** One transaction as the desk hands it back: where, what calldata, how much ETH (wei, a decimal string), which chain. */
export interface SendRequest { to: string; data: string; value: string; chainId: number; }
/** A payment the desk priced: credits to the treasury (ETH, or a token moved to it), or ETH to the agent's own wallet. */
export interface PayRequest extends SendRequest { token: string; amount: number; purpose?: 'credits' | 'fund'; treasury?: string; }
/** One step of a console swap: the approvals a token input needs, then the swap. */
export interface StepRequest extends SendRequest { id: string; }
export type SendVerdict = { ok: true; label: string } | { ok: false; reason: string };

const SELECTOR: Record<string, 'transfer' | 'approve' | 'permit2Approve'> = {
  '0xa9059cbb': 'transfer',        // transfer(address,uint256)
  '0x095ea7b3': 'approve',         // approve(address,uint256)
  '0x87517c45': 'permit2Approve',  // Permit2's approve(address token, address spender, uint160 amount, uint48 expiration)
};
/** The desk rounds ETH to eight decimals before it says an amount; one unit of that is the slack allowed between the value and the amount stated. */
const ROUNDING_WEI = 10n ** 10n;

export const isAddress = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
export const sameAddress = (a: unknown, b: unknown): boolean => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
/** ETH as the desk states it, in wei: the same eight-decimal rounding the desk uses to build the value. */
export const weiOf = (amount: number): bigint => BigInt(Math.round(amount * 1e8)) * ROUNDING_WEI;
/** Wei as a person reads it, for the line printed before signing. */
export const ethText = (v: bigint): string => (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 8 });

const wei = (v: unknown): bigint | null => {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) { return null; }
  return BigInt(v);
};
const closeTo = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= ROUNDING_WEI;
const word = (data: string, i: number): string => data.slice(10 + 64 * i, 10 + 64 * (i + 1));
const addressWord = (w: string): string | null => (/^0{24}[0-9a-fA-F]{40}$/.test(w) ? '0x' + w.slice(24) : null);

/** A token call decoded from its calldata: an ERC-20 transfer or approve (to whom, how much), or Permit2's approve (which token, which spender). Null for anything else. */
export function tokenCall(data: unknown): { fn: 'transfer' | 'approve'; address: string; amount: bigint } | { fn: 'permit2Approve'; token: string; spender: string } | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) { return null; }
  const fn = SELECTOR[data.slice(0, 10).toLowerCase()];
  if (!fn) { return null; }
  if (fn === 'permit2Approve') {
    if (data.length !== 10 + 64 * 4) { return null; }
    const token = addressWord(word(data, 0));
    const spender = addressWord(word(data, 1));
    return token && spender ? { fn, token, spender } : null;
  }
  if (data.length !== 10 + 64 * 2) { return null; }
  const address = addressWord(word(data, 0));
  return address ? { fn, address, amount: BigInt('0x' + word(data, 1)) } : null;
}

/** The checks every transaction passes first: the chain the console lives on, a destination that is an address, a value that is wei. */
function common(t: SendRequest): { ok: true; value: bigint } | { ok: false; reason: string } {
  if (t.chainId !== ROBINHOOD_CHAIN_ID) { return { ok: false, reason: 'it is for chain ' + String(t.chainId) + ', not Robinhood Chain (' + ROBINHOOD_CHAIN_ID + ')' }; }
  if (!isAddress(t.to)) { return { ok: false, reason: 'its destination is not an address' }; }
  const value = wei(t.value);
  if (value === null) { return { ok: false, reason: 'its value is not a number of wei' }; }
  return { ok: true, value };
}

/**
 * A payment, judged. A funding is bare ETH, the amount stated, to the agent's wallet the console learned at sign-in
 * or from /wallet, never to an address the reply alone names. Credits in ETH go straight to the treasury the reply
 * names, the amount stated; credits in a token are that token's transfer to the treasury with no ETH attached.
 */
export function judgePay(p: PayRequest, agentWallet: string | null): SendVerdict {
  const c = common(p);
  if (c.ok === false) { return c; }
  if (p.purpose === 'fund') {
    if (!isAddress(agentWallet)) { return { ok: false, reason: 'the console does not know your agent\'s wallet yet; type /wallet first' }; }
    if (!sameAddress(p.to, agentWallet)) { return { ok: false, reason: 'its destination ' + p.to + ' is not your agent\'s wallet ' + agentWallet }; }
    if (p.data !== '0x') { return { ok: false, reason: 'a funding carries no calldata, and this one does' }; }
    if (!closeTo(c.value, weiOf(p.amount))) { return { ok: false, reason: 'its value ' + ethText(c.value) + ' ETH is not the ' + String(p.amount) + ' ETH stated' }; }
    return { ok: true, label: 'your agent\'s wallet' };
  }
  if (!isAddress(p.treasury)) { return { ok: false, reason: 'the payment names no treasury' }; }
  if (p.token === 'ETH') {
    if (!sameAddress(p.to, p.treasury)) { return { ok: false, reason: 'its destination ' + p.to + ' is not the credits treasury ' + p.treasury }; }
    if (p.data !== '0x') { return { ok: false, reason: 'an ETH payment carries no calldata, and this one does' }; }
    if (!closeTo(c.value, weiOf(p.amount))) { return { ok: false, reason: 'its value ' + ethText(c.value) + ' ETH is not the ' + String(p.amount) + ' ETH stated' }; }
    return { ok: true, label: 'the credits treasury' };
  }
  const call = tokenCall(p.data);
  if (!call || call.fn !== 'transfer') { return { ok: false, reason: 'its calldata is not a token transfer' }; }
  if (!sameAddress(call.address, p.treasury)) { return { ok: false, reason: 'the transfer pays ' + call.address + ', not the credits treasury ' + p.treasury }; }
  if (c.value !== 0n) { return { ok: false, reason: 'a token payment carries no ETH, and this one carries ' + ethText(c.value) }; }
  return { ok: true, label: 'the ' + p.token + ' contract, paying the credits treasury ' + p.treasury };
}

/**
 * One swap step, judged. The swap itself goes to the Universal Router. A Permit2 approval goes to Permit2 and names
 * the router as the spender, nothing else. A token approval goes to the token being swapped and names Permit2 as
 * the spender; the token's address is the one thing here the desk chooses, and all such a call can do is let
 * Permit2 move that token. Nothing but the swap carries ETH.
 */
export function judgeStep(st: StepRequest): SendVerdict {
  const c = common(st);
  if (c.ok === false) { return c; }
  if (st.id === 'swap') {
    if (!sameAddress(st.to, UNIVERSAL_ROUTER)) { return { ok: false, reason: 'its destination ' + st.to + ' is not the swap router ' + UNIVERSAL_ROUTER }; }
    return { ok: true, label: 'the swap router' };
  }
  if (c.value !== 0n) { return { ok: false, reason: 'an approval carries no ETH, and this one carries ' + ethText(c.value) }; }
  const call = tokenCall(st.data);
  if (st.id === 'approve-permit2') {
    if (!sameAddress(st.to, PERMIT2)) { return { ok: false, reason: 'its destination ' + st.to + ' is not Permit2 ' + PERMIT2 }; }
    if (!call || call.fn !== 'permit2Approve') { return { ok: false, reason: 'its calldata is not a Permit2 approval' }; }
    if (!sameAddress(call.spender, UNIVERSAL_ROUTER)) { return { ok: false, reason: 'it would let ' + call.spender + ' draw the token, not the swap router' }; }
    return { ok: true, label: 'Permit2, letting the swap router draw the token' };
  }
  if (st.id === 'approve-token') {
    if (!call || call.fn !== 'approve') { return { ok: false, reason: 'its calldata is not a token approval' }; }
    if (!sameAddress(call.address, PERMIT2)) { return { ok: false, reason: 'it would let ' + call.address + ' move the token, not Permit2' }; }
    return { ok: true, label: 'the token\'s contract, letting Permit2 move it' };
  }
  return { ok: false, reason: '"' + st.id + '" is not a step the console knows' };
}

/** The line printed before the wallet opens: where it goes, what ETH rides along, on which chain. */
export function sendLine(t: SendRequest, label: string): string {
  const v = wei(t.value) ?? 0n;
  const chain = t.chainId === ROBINHOOD_CHAIN_ID ? 'Robinhood Chain' : 'chain ' + String(t.chainId);
  return 'To ' + String(t.to) + ' (' + label + '), ' + (v === 0n ? 'no ETH attached' : ethText(v) + ' ETH') + ', on ' + chain + '.';
}
