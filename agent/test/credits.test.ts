import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceUsd, creditsSummary, resolvePayToken, judgePayment, bonusPct, treasury, creditsOn, toCredits, fmtCredits, freeUsd, treasuryIsDesk, capitalRowFor, type CreditRow, type PayToken } from "../src/desk/credits.ts";
import { receivedStocks } from "../src/obscura/reads.ts";
import { parseCatalog, findModels, featured, estimateTokens, turnCostUsd, modelLine } from "../src/desk/models.ts";
import { sanitizeSettings, describeSettings } from "../src/desk/userSettings.ts";

const ME = "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38";
const TREASURY = "0x000000000000000000000000000000000000beef";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const tokens: PayToken[] = [
  { symbol: "ETH", kind: "native", contract: null, decimals: 18, group: "eth" },
  { symbol: "USDG", kind: "erc20", contract: "0x0000000000000000000000000000000000000001", decimals: 6, group: "dollar" },
  { symbol: "AOBS", kind: "erc20", contract: "0x0000000000000000000000000000000000000002", decimals: 18, group: "agent" },
  { symbol: "NVDA", kind: "erc20", contract: "0x0000000000000000000000000000000000000003", decimals: 18, group: "stock" },
];

test("credits are grants and deposits in, charges out, per wallet, and read at a glance", () => {
  const rows: CreditRow[] = [
    { at: 1, address: ME.toLowerCase(), kind: "grant", usd: 1 },
    { at: 2, address: ME.toLowerCase(), kind: "deposit", usd: 10.5, token: "USDG", amount: 10.5 },
    { at: 3, address: ME.toLowerCase(), kind: "charge", usd: 0.0123, model: "x/y", tokensIn: 100, tokensOut: 50 },
    { at: 4, address: "0x000000000000000000000000000000000000dead", kind: "deposit", usd: 99 },
  ];
  assert.equal(balanceUsd(ME, rows), 11.4877);
  const s = creditsSummary(ME, rows);
  assert.deepEqual([s.granted, s.deposited, s.spent, s.turns], [1, 10.5, 0.0123, 1]);
  assert.equal(balanceUsd("0x0000000000000000000000000000000000000009", rows), 0);
  assert.equal(treasury({} as NodeJS.ProcessEnv), null);
  assert.equal(creditsOn({ OBS_CREDITS_TREASURY: TREASURY } as NodeJS.ProcessEnv), true);
  assert.equal(bonusPct("AOBS", { OBS_CREDITS_AOBS_BONUS_PCT: "12" } as NodeJS.ProcessEnv), 12);
  assert.equal(bonusPct("USDG", {} as NodeJS.ProcessEnv), 0);
  // The unit: a credit is a cent, so ten dollars of USDG are a thousand credits.
  assert.equal(toCredits(10), 1000);
  assert.equal(toCredits(0.00055), 0.06);
  assert.equal(fmtCredits(1000), "1,000");
  assert.equal(fmtCredits(99.945), "99.95");
  assert.equal(freeUsd({} as NodeJS.ProcessEnv), 1, "a hundred credits on the house is a dollar in the ledger");
  assert.equal(freeUsd({ OBS_CREDITS_FREE: "250" } as NodeJS.ProcessEnv), 2.5);
});

test("when the treasury is the desk's own wallet, a payment is capital handed to the desk, and a stock paid with is read as a holding", () => {
  assert.equal(treasuryIsDesk({ OBS_CREDITS_TREASURY: ME } as NodeJS.ProcessEnv, ME), true);
  assert.equal(treasuryIsDesk({ OBS_CREDITS_TREASURY: ME.toLowerCase() } as NodeJS.ProcessEnv, ME), true, "case does not matter");
  assert.equal(treasuryIsDesk({ OBS_CREDITS_TREASURY: TREASURY } as NodeJS.ProcessEnv, ME), false, "a separate treasury is not the book");
  assert.equal(treasuryIsDesk({} as NodeJS.ProcessEnv, ME), false);
  const row = capitalRowFor("0x000000000000000000000000000000000000dEaD", "nvda", 0.5, 114.257, "0xABC", 5);
  assert.deepEqual(row, { at: 5, kind: "deposit", asset: "NVDA", amount: 0.5, usd: 114.26, note: "credits bought by 0x000000000000000000000000000000000000dead", txHash: "0xabc", from: "0x000000000000000000000000000000000000dead" });
  const stocks = { NVDA: "0x3", AAPL: "0x4" };
  assert.deepEqual(receivedStocks([{ kind: "deposit", token: "aapl" }, { kind: "deposit", token: "USDG" }, { kind: "charge", token: "NVDA" }, { kind: "deposit", token: "AAPL" }], stocks), [{ symbol: "AAPL", contract: "0x4" }]);
  assert.deepEqual(receivedStocks([], stocks), []);
});

test("a payment is what a person names it, and what the chain says it was", () => {
  assert.equal(resolvePayToken("usdg", tokens)?.symbol, "USDG");
  assert.equal(resolvePayToken("RH ETH", tokens)?.symbol, "ETH");
  assert.equal(resolvePayToken("nvda@robinhood", tokens)?.symbol, "NVDA");
  assert.equal(resolvePayToken("DOGE", tokens), null);
  const eth = judgePayment({ from: ME, to: TREASURY, value: 5000000000000000n }, [], ME, TREASURY, tokens);
  assert.deepEqual("token" in eth ? [eth.token.symbol, eth.amount] : eth, ["ETH", 0.005]);
  const log = { address: tokens[1].contract as string, topics: [TRANSFER, topic(ME), topic(TREASURY)], data: "0x" + (10_500_000n).toString(16).padStart(64, "0") };
  const usdg = judgePayment({ from: ME, to: tokens[1].contract, value: 0n }, [log], ME, TREASURY, tokens);
  assert.deepEqual("token" in usdg ? [usdg.token.symbol, usdg.amount] : usdg, ["USDG", 10.5]);
  const elsewhere = { ...log, topics: [TRANSFER, topic(ME), topic("0x000000000000000000000000000000000000dead")] };
  assert.match((judgePayment({ from: ME, to: tokens[1].contract, value: 0n }, [elsewhere], ME, TREASURY, tokens) as { reason: string }).reason, /nothing in that transaction reached/);
  assert.match((judgePayment({ from: "0x000000000000000000000000000000000000dead", to: TREASURY, value: 1n }, [], ME, TREASURY, tokens) as { reason: string }).reason, /not sent by this wallet/);
});

test("the catalog is read with its prices, searched by words, and a turn is priced from the text with the margin on top", () => {
  const cat = parseCatalog([
    { id: "anthropic/claude-opus-5", name: "Anthropic: Claude Opus 5", context_length: 1000000, pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", context_length: 128000, pricing: { prompt: "0.00000014", completion: "0.00000028" } },
    { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM (free)", context_length: 32000, pricing: { prompt: "0", completion: "0" } },
    { id: "broken/model", name: "no price", pricing: {} },
  ]);
  assert.equal(cat.length, 3, "a row without a price is not offered");
  assert.equal(cat[0].promptPerM, 5);
  assert.equal(cat[2].free, true);
  assert.deepEqual(findModels(cat, "claude opus").map((m) => m.id), ["anthropic/claude-opus-5"]);
  assert.deepEqual(findModels(cat, "free").map((m) => m.id), ["liquid/lfm-2.5-2.6b:free"]);
  assert.deepEqual(findModels(cat, "deepseek/deepseek-v4-flash-0731").map((m) => m.id), ["deepseek/deepseek-v4-flash-0731"]);
  assert.deepEqual(findModels(cat, "nothing like it"), []);
  assert.deepEqual(featured(cat, ["deepseek/deepseek-v4-flash-0731", "missing/model"]).map((m) => m.id), ["deepseek/deepseek-v4-flash-0731"]);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(turnCostUsd(cat[0], 1000, 200, 25), 0.0125, "5 in + 5 out per million, with a quarter on top");
  assert.equal(turnCostUsd(cat[2], 1000, 200, 25), 0);
  assert.match(modelLine(cat[0], true), /^> anthropic\/claude-opus-5  \$5\.00 in, \$25\.00 out per million tokens/);
  assert.match(modelLine(cat[2]), /free$/);
});

test("a model is a setting, checked as an id, shown with the rest", () => {
  const ok = sanitizeSettings({ model: " anthropic/claude-opus-5 " });
  assert.deepEqual(ok, { settings: { model: "anthropic/claude-opus-5" } });
  assert.ok("error" in sanitizeSettings({ model: "not an id" }));
  assert.deepEqual(sanitizeSettings({ model: "" }), { settings: { model: "" } }, "an empty model goes back to the default");
  assert.match(describeSettings({}).join("\n"), /model   the default/);
  assert.match(describeSettings({ model: "x/y" }).join("\n"), /model   x\/y/);
});
