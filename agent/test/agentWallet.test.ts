import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey, agentWalletAddress, walletsOn, fundTx, judgeFunding, walletBook, walletLines, MIN_FUND_ETH } from "../src/desk/agentWallet.ts";

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
  for (const l of lines) assert.ok(!l.includes("—"));
});
