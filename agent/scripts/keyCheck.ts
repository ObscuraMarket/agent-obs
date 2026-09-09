// Which wallet the desk's key file signs for, and whether that is the wallet the desk is told to trade from. Prints
// addresses only, never the key. Run inside the desk after OBS_WALLET_JSON changes.
//   npx tsx scripts/keyCheck.ts
import { existsSync, readFileSync } from "node:fs";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_ADDRESS } from "../src/config.ts";
import { walletFile } from "../src/desk/rails.ts";
import { ASSETS } from "../src/desk/assets.ts";
import { readNativeBalance } from "../src/desk/signer.ts";
import { aaOn, gasWalletFile, loadGasAccount, entryPointDeposit } from "../src/desk/aa.ts";

const path = walletFile();
if (!existsSync(path)) { console.log(`no key file at ${path}: the desk cannot sign (the boot writes one from OBS_WALLET_JSON when none exists)`); process.exit(1); }
let w: { address?: string; privateKey?: string } = {};
try { w = JSON.parse(readFileSync(path, "utf8")); } catch { console.error("the key file is not valid JSON"); process.exit(1); }
const key = String(w.privateKey ?? "");
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error(`the key file's privateKey is not a 32-byte hex key (${key.length} chars): fix OBS_WALLET_JSON, delete the file, restart`); process.exit(1); }
const derived = privateKeyToAccount(key as `0x${string}`).address;
console.log(`key file at ${path}`);
console.log(`  address field: ${w.address ?? "(none)"}`);
console.log(`  the key signs for: ${derived}`);
console.log(`  OBS_WALLET_ADDRESS: ${WALLET_ADDRESS || "(unset)"}`);
const ok = derived.toLowerCase() === (WALLET_ADDRESS || "").toLowerCase() && (w.address ?? derived).toLowerCase() === derived.toLowerCase();
console.log(ok ? "match: the desk signs for the wallet it trades from" : "MISMATCH: the desk would sign for a different wallet than it trades from; fix OBS_WALLET_JSON or OBS_WALLET_ADDRESS");
// The gas wallet (OBS_EXEC=aa): the second key file, its address and native balance, and the trading wallet's entry point deposit. Addresses only.
const gasPath = gasWalletFile();
if (existsSync(gasPath)) {
  try {
    const gas = loadGasAccount();
    console.log(`gas wallet file at ${gasPath}`);
    console.log(`  the key signs for: ${gas.address}${process.env.OBS_GAS_WALLET_ADDRESS ? ` (OBS_GAS_WALLET_ADDRESS ${process.env.OBS_GAS_WALLET_ADDRESS})` : ""}`);
    try {
      const [native, deposit] = await Promise.all([readNativeBalance(ASSETS["ETH@robinhood"], gas.address), entryPointDeposit()]);
      console.log(`  native ETH: ${formatEther(native)}`);
      console.log(`  entry point deposit of ${WALLET_ADDRESS || "(unset)"}: ${formatEther(deposit)} ETH`);
    } catch (e) {
      console.log(`  the chain did not answer for the balances: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  } catch (e) {
    console.log(`gas wallet file at ${gasPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  console.log(`no gas wallet file at ${gasPath} (OBS_GAS_WALLET_JSON writes one at boot)${aaOn() ? "; OBS_EXEC=aa cannot send without it" : ""}`);
}
process.exit(ok ? 0 : 1);
