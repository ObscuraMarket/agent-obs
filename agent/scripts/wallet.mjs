#!/usr/bin/env node
// OBS's own wallet. One EVM key, generated here, stored outside the repo with
// owner-only permissions. The same address works on Ethereum, Base, Arbitrum,
// BSC and Robinhood Chain, which covers the routes the desk cares about.
//
//   node scripts/wallet.mjs create          generate the key (refuses to overwrite)
//   node scripts/wallet.mjs address         print the public address
//   node scripts/wallet.mjs export --reveal print the private key, for the operator's backup only
//
// Nothing in the agent's loops loads the key. Until the execution stage
// exists the address is the only thing the code reads (OBS_WALLET_ADDRESS).
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.OBS_WALLET_DIR || join(homedir(), ".obs", "wallet");
const FILE = join(DIR, "obs-wallet.json");
const cmd = process.argv[2];

function load() {
  if (!existsSync(FILE)) {
    console.error(`no wallet at ${FILE}; run: node scripts/wallet.mjs create`);
    process.exit(1);
  }
  const mode = statSync(FILE).mode & 0o777;
  if (mode !== 0o600) console.error(`warning: ${FILE} has mode ${mode.toString(8)}, expected 600`);
  return JSON.parse(readFileSync(FILE, "utf8"));
}

if (cmd === "create") {
  if (existsSync(FILE)) {
    console.error(`refusing: a wallet already exists at ${FILE}\n(address ${load().address}). Move it away deliberately if you truly want a new one.`);
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeFileSync(FILE, JSON.stringify({ address: account.address, privateKey, createdAt: new Date().toISOString(), kind: "evm" }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FILE, 0o600);
  console.log(`created OBS wallet\n  address: ${account.address}\n  key file: ${FILE} (mode 600, outside the repo)\n\nNext: put OBS_WALLET_ADDRESS=${account.address} in agent/.env, and back the key file up somewhere offline.`);
} else if (cmd === "address") {
  console.log(load().address);
} else if (cmd === "export") {
  if (!process.argv.includes("--reveal")) {
    console.error("export prints the PRIVATE KEY. Run with --reveal, in a terminal you trust, for a backup only.");
    process.exit(1);
  }
  const w = load();
  console.log(w.privateKey);
} else {
  console.log("usage: node scripts/wallet.mjs <create|address|export --reveal>");
  process.exit(cmd ? 1 : 0);
}
