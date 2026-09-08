// The offline half of agent-wallet custody: derive a person's agent wallet from the seed without the desk running,
// so a user can be paid back if the desk is down for good. Prints the address by default; the private key only
// with --key, and only to the terminal, never to a log. Run on a machine you trust, with the seed in the
// environment for this one command and nowhere else (audit, 2026-09-08).
//
//   OBS_AGENT_WALLET_SEED=... npx tsx scripts/deriveAgentWallet.ts 0x<the person's signing address> [--key]
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey } from "../src/desk/agentWallet.ts";

const args = process.argv.slice(2);
const address = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const wantKey = args.includes("--key");
const seed = process.env.OBS_AGENT_WALLET_SEED ?? "";
if (!address) { console.error("usage: OBS_AGENT_WALLET_SEED=... npx tsx scripts/deriveAgentWallet.ts 0x<signing address> [--key]"); process.exit(2); }
if (seed.length < 32) { console.error("OBS_AGENT_WALLET_SEED is not set (at least 32 characters): the derivation needs the same seed the desk runs with"); process.exit(2); }
const key = deriveKey(seed, address);
const account = privateKeyToAccount(key);
console.log(`agent wallet for ${address}: ${account.address}`);
if (wantKey) {
  console.log("private key (import it into a wallet to move the funds; it controls this agent wallet and nothing else):");
  console.log(key);
}
