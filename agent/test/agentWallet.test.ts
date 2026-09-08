import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey, agentWalletAddress, agentWalletAddressOrNull, agentWallet, walletMismatch, WalletDerivationError, WALLET_DERIVATION_LINE, walletsOn, fundTx, judgeFunding, walletBook, walletLines, fundConfirmations, MIN_FUND_ETH, type Pager, type AgentCapitalRow, pickToken, withdrawTokenTx, quoteUsd } from "../src/desk/agentWallet.ts";
import { priorRecord, judgeBlock } from "../src/desk/credits.ts";
import { decodeFunctionData, erc20Abi } from "viem";
import { ASSETS, type Asset } from "../src/desk/assets.ts";

const SEED = "a-seed-for-the-tests-that-is-long-enough-to-count-0123456789";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("an agent wallet is derived from the seed and the person's address: the same every time, different for everyone, never the seed itself", () => {
  assert.equal(walletsOn({} as NodeJS.ProcessEnv), false, "no seed, no wallets");
  assert.equal(walletsOn({ OBS_AGENT_WALLET_SEED: "short" } as NodeJS.ProcessEnv), false, "a short seed does not count");
  const env = { OBS_AGENT_WALLET_SEED: SEED } as NodeJS.ProcessEnv;
  assert.equal(walletsOn(env), true);
  const k1 = deriveKey(SEED, A);
  assert.match(k1, /^0x[0-9a-f]{64}$/);
  assert.equal(deriveKey(SEED, A.toUpperCase().replace("0X", "0x")), k1, "case does not change the wallet");
  assert.notEqual(deriveKey(SEED, B), k1, "another person, another wallet");
  assert.notEqual(deriveKey(SEED + "x", A), k1, "another seed, another wallet");
  const w = agentWalletAddress(A, env);
  assert.equal(w, privateKeyToAccount(k1).address, "the address is the derived key's");
  assert.equal(agentWalletAddress(A, env), w, "stable across calls");
  assert.throws(() => agentWalletAddress(A, {} as NodeJS.ProcessEnv), /not switched on/);
});

test("a wallet the ledger remembers is held against today's derivation: a rotated or mistyped seed is the console's line and a page, never a fresh address", () => {
  const env = { OBS_AGENT_WALLET_SEED: SEED } as NodeJS.ProcessEnv;
  const rotated = { OBS_AGENT_WALLET_SEED: SEED + "-rotated-by-mistake" } as NodeJS.ProcessEnv;
  const paged: Array<{ kind: string; text: string; now: number | undefined }> = [];
  const page: Pager = async (kind, text, now) => { paged.push({ kind, text, now }); return true; };
  const w = agentWalletAddress(A, env, [], page);
  // The row as rememberWallet writes it: the address and the wallet as first shown, both in lower case.
  const rows = [{ address: A, wallet: w.toLowerCase(), at: 1 }];
  assert.equal(walletMismatch(A, w, rows), null, "the same seed derives the remembered wallet");
  assert.equal(walletMismatch(A.toUpperCase().replace("0X", "0x"), w.toUpperCase().replace("0X", "0x"), rows), null, "case is not a mismatch");
  assert.equal(walletMismatch(B, w, rows), null, "no row yet, nothing to hold against");
  assert.equal(agentWalletAddress(A, env, rows, page), w, "a wallet that matches its row is the wallet");
  assert.equal(agentWallet(A, env, rows, page).address, w);
  assert.equal(agentWalletAddressOrNull(A, env, rows, page), w);
  assert.equal(paged.length, 0, "nothing to page while the seed derives what is remembered");

  const fresh = agentWalletAddress(A, rotated, [], page);
  assert.notEqual(fresh, w, "the rotated seed derives some other wallet");
  assert.deepEqual(walletMismatch(A, fresh, rows), { remembered: w.toLowerCase(), derived: fresh.toLowerCase() });
  assert.throws(() => agentWalletAddress(A, rotated, rows, page, 1234), (e: unknown) => e instanceof WalletDerivationError && e.message === WALLET_DERIVATION_LINE && e.address === A);
  assert.throws(() => agentWallet(A, rotated, rows, page, 1234), WalletDerivationError, "the signer the mirror and withdraw use is held to the same row");
  assert.equal(paged.length, 2, "each refused derivation pages; the alarm's own cooldown makes them one message");
  assert.equal(paged[0].kind, "cycle");
  assert.equal(paged[0].now, 1234);
  assert.match(paged[0].text, /^an agent wallet cannot be derived: the desk remembers 0x[0-9a-f]{4}\.\.\.[0-9a-f]{4} for 0x1111\.\.\.1111 and today's OBS_AGENT_WALLET_SEED derives 0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}; the seed was rotated or mistyped/);
  for (const t of [paged[0].text, paged[1].text, WALLET_DERIVATION_LINE]) {
    assert.ok(!t.includes(SEED), "the seed is never in the page or the line");
    assert.ok(!t.toLowerCase().includes(fresh.toLowerCase()), "nor is the fresh address in full");
    assert.ok(!t.includes("—"));
  }
  assert.equal(WALLET_DERIVATION_LINE, "Your agent's wallet cannot be derived right now; the operator has been paged.");

  assert.equal(agentWalletAddressOrNull(A, rotated, rows, page), null, "the persona and the public list get null, not a fresh address");
  assert.equal(agentWalletAddressOrNull(B, rotated, rows, page), agentWalletAddress(B, rotated, [], page), "an address with no row derives as before");
  assert.equal(agentWalletAddressOrNull(A, {} as NodeJS.ProcessEnv, rows, page), null, "wallets off is null, not a throw");
});

test("funding is ETH to the agent's wallet and nothing else; a landed transaction is judged by sender, destination and value", () => {
  const w = "0x3333333333333333333333333333333333333333" as const;
  const tx = fundTx(w, 0.05);
  assert.ok(!("error" in tx));
  if (!("error" in tx)) {
    assert.deepEqual([tx.to, tx.data, tx.value, tx.chainId, tx.token, tx.amount, tx.purpose], [w, "0x", "50000000000000000", 4663, "ETH", 0.05, "fund"]);
  }
  assert.match((fundTx(w, MIN_FUND_ETH / 2) as { error: string }).error, /smallest funding/);
  assert.deepEqual(judgeFunding({ from: A, to: w, value: 10n ** 16n }, A, w), { amount: 0.01 });
  assert.match((judgeFunding({ from: B, to: w, value: 10n ** 16n }, A, w) as { reason: string }).reason, /not sent by this wallet/);
  assert.match((judgeFunding({ from: A, to: B, value: 10n ** 16n }, A, w) as { reason: string }).reason, /did not go to your agent's wallet/);
  assert.match((judgeFunding({ from: A, to: w, value: 0n }, A, w) as { reason: string }).reason, /carried no ETH/);
});

test("a funding is recorded once for the wallet that sent it, after a couple of blocks, whatever its age", () => {
  const rows: AgentCapitalRow[] = [{ address: A, at: 1, kind: "deposit", asset: "ETH", amount: 0.05, usd: 120, txHash: "0xaa" }];
  const mine = priorRecord(rows, "0xAA", A);
  assert.ok(mine && "row" in mine && mine.row.amount === 0.05);
  assert.equal((priorRecord(rows, "0xaa", B) as { reason: string }).reason, "that transaction is already counted for the address that sent it");
  assert.equal(fundConfirmations({} as NodeJS.ProcessEnv), 2);
  assert.equal(fundConfirmations({ OBS_FUND_CONFIRMATIONS: "5" } as NodeJS.ProcessEnv), 5);
  assert.equal(fundConfirmations({ OBS_FUND_CONFIRMATIONS: "-1" } as NodeJS.ProcessEnv), 2, "a broken value is the default");
  const now = 1_700_000_000_000;
  const rule = { confirmations: fundConfirmations({} as NodeJS.ProcessEnv), maxAgeH: null };
  assert.match((judgeBlock({ blockNumber: 10n, head: 10n, blockAt: now }, now, rule) as { reason: string }).reason, /has 1 confirmation and 2 are needed/);
  assert.ok("ok" in judgeBlock({ blockNumber: 10n, head: 11n, blockAt: now - 90 * 24 * 3600e3 }, now, rule), "an old funding is still ETH in the agent's wallet");
});

test("the wallet book adds up what went in and out for one person, and the lines say what to do with it", () => {
  const rows = [
    { address: A, at: 1, kind: "deposit" as const, asset: "ETH" as const, amount: 0.05, usd: 120, txHash: "0xa" },
    { address: A, at: 2, kind: "withdraw" as const, asset: "ETH" as const, amount: 0.02, usd: 48, txHash: "0xb" },
    { address: B, at: 3, kind: "deposit" as const, asset: "ETH" as const, amount: 1, usd: 2400, txHash: "0xc" },
  ];
  assert.deepEqual(walletBook(A, rows), { depositedEth: 0.05, withdrawnEth: 0.02, deposits: 1, withdrawals: 1, netUsd: 72 });
  assert.deepEqual(walletBook("0x4444444444444444444444444444444444444444", rows), { depositedEth: 0, withdrawnEth: 0, deposits: 0, withdrawals: 0, netUsd: 0 });
  const lines = walletLines("0x3333333333333333333333333333333333333333", 0.03, 2400, walletBook(A, rows), "https://x");
  assert.match(lines[0], /^Your agent's wallet: 0x3333/);
  assert.match(lines[1], /holds 0\.03000 ETH \(\$72\.00\)\. https:\/\/x\/address\/0x3333/);
  assert.match(lines[2], /0\.05000 ETH in over 1 funding, 0\.02000 ETH out over 1 withdrawal/);
  assert.ok(lines.some((l) => /\/withdraw all; it can only ever go to the wallet you signed in with/.test(l)));
  assert.ok(lines.some((l) => /\/withdraw LENNY sends all of it, \/sell LENNY sells all of it for ETH/.test(l)), "the lines teach the token forms");
  for (const l of lines) assert.ok(!l.includes("—"));
  // A token sent out whole is value out where the pools priced it, and never an ETH withdrawal.
  const withToken = [...rows, { address: A, at: 4, kind: "withdraw-token" as const, asset: "LENNY", contract: "0x5555555555555555555555555555555555555555", amount: 1000, usd: 12, txHash: "0xd" }];
  assert.deepEqual(walletBook(A, withToken), { depositedEth: 0.05, withdrawnEth: 0.02, deposits: 1, withdrawals: 1, netUsd: 60 });
  assert.equal(walletBook(A, [...rows, { ...withToken[3], usd: null }]).netUsd, 72, "unpriced, it changes no tally");
});

test("a token leaves the agent's wallet only when the desk knows it on Robinhood Chain and never trades it; ETH goes by amount", () => {
  const lenny: Asset = { symbol: "LENNY", code: "lenny", network: "robinhood", chain: "robinhood", kind: "erc20", contract: "0x5555555555555555555555555555555555555555", decimals: 18, deposit: false, withdrawal: false };
  const aobs: Asset = { ...lenny, symbol: "AOBS", code: "aobs", contract: "0x6666666666666666666666666666666666666666" };
  const asked: string[] = [];
  const resolve = (spec: string): Asset | null => { asked.push(spec); return spec === "LENNY@robinhood" ? lenny : spec === "AOBS@robinhood" ? aobs : spec === "ETH@robinhood" ? ASSETS["ETH@robinhood"] : spec === "WETH@robinhood" ? { ...ASSETS["ETH@robinhood"], symbol: "WETH" } : null; };
  const never = new Set([aobs.contract as string]);
  assert.deepEqual(pickToken("lenny", resolve, never), { ok: true, token: lenny });
  assert.deepEqual(asked, ["LENNY@robinhood"], "asked for the token on this chain, whatever case it was typed in");
  assert.match((pickToken("ETH", resolve, never) as { reason: string }).reason, /^ETH goes by amount: \/withdraw 0\.02 or \/withdraw all\./);
  assert.equal(asked.length, 1, "ETH is refused before anything is resolved");
  assert.match((pickToken("", resolve, never) as { reason: string }).reason, /^Say which token/);
  assert.match((pickToken("USDC", resolve, never) as { reason: string }).reason, /doesn't know a token called USDC on Robinhood Chain/, "a symbol the registry knows on Ethereum is not a token here");
  assert.match((pickToken("aobs", resolve, never) as { reason: string }).reason, /AOBS is on the desk's never-trade list/);
  assert.match((pickToken("WETH", resolve, never) as { reason: string }).reason, /not a token the desk can transfer/, "nothing without a contract is transferred");
  const tx = withdrawTokenTx(lenny, A, 123n);
  assert.equal(tx.to, lenny.contract);
  assert.ok(tx.data.startsWith("0xa9059cbb"), "the token's own transfer");
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  assert.equal(decoded.functionName, "transfer");
  assert.deepEqual(decoded.args, [A, 123n]);
  assert.equal(quoteUsd({ priceInUsd: 0.5, amountOut: 0.01 }, 100, 2500), 50, "the pool's own price first");
  assert.equal(quoteUsd({ priceInUsd: null, amountOut: 0.01 }, 100, 2500), 25, "else the ETH it fetches at the desk's ETH price");
  assert.equal(quoteUsd({ priceInUsd: null, amountOut: 0.01 }, 100, null), null);
  assert.equal(quoteUsd(null, 100, 2500), null);
});
