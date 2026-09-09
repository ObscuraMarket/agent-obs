// Unwrap the desk wallet's WETH into native ETH on Robinhood Chain, signed by the desk's own key. The wallet the
// desk moved to on 2026-09-08 lives in an app that wraps every deposit, and the lane spends native ETH for swap
// value and gas, so the wallet needs some ETH unwrapped before it can trade. Unwrapping costs gas itself, so a
// little native ETH must already be there. Run inside the desk.
//   npx tsx scripts/unwrap.ts <amount in ETH | all>   [--dry]
import { encodeFunctionData, formatEther, parseAbi, parseEther } from "viem";
import { WETH_CONTRACT, WALLET_ADDRESS } from "../src/config.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { readNativeBalance, readTokenBalance, simulateFromWallet, sendTx, waitReceipt } from "../src/desk/signer.ts";

const [amountArg, ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry");
if (!amountArg) { console.error("usage: unwrap.ts <amount in ETH | all> [--dry]"); process.exit(2); }
const eth = resolveAsset("ETH@robinhood");
if (!eth) { console.error("ETH@robinhood is not in the registry"); process.exit(1); }
const weth = WETH_CONTRACT as `0x${string}`;
const [native, wrapped] = await Promise.all([readNativeBalance(eth), readTokenBalance(eth, weth)]);
console.log(`wallet ${WALLET_ADDRESS}: ${formatEther(native)} ETH native, ${formatEther(wrapped)} WETH`);
const GAS_FLOOR = parseEther("0.0003");
if (native < GAS_FLOOR) { console.error(`not enough native ETH to pay for the unwrap (${formatEther(native)}); send a little native ETH to the wallet first`); process.exit(1); }
const amount = amountArg === "all" ? wrapped : parseEther(amountArg);
if (amount <= 0n || amount > wrapped) { console.error(`cannot unwrap ${formatEther(amount)}: the wallet holds ${formatEther(wrapped)} WETH`); process.exit(1); }
const tx = { to: weth, data: encodeFunctionData({ abi: parseAbi(["function withdraw(uint256 wad)"]), functionName: "withdraw", args: [amount] }), value: 0n };
const sim = await simulateFromWallet(eth, tx);
if (!sim.ok) { console.error(`the unwrap would revert: ${sim.reason}`); process.exit(1); }
console.log(`unwrapping ${formatEther(amount)} WETH into ETH${dry ? " (dry: nothing sent)" : ""}`);
if (dry) process.exit(0);
const hash = await sendTx(eth, tx);
console.log(`sent ${hash}`);
const r = await waitReceipt(eth, hash);
if (!r || r.status !== "success") { console.error(`the unwrap ${r ? "reverted" : "did not land in time"}: ${hash}`); process.exit(1); }
const [after, afterW] = await Promise.all([readNativeBalance(eth), readTokenBalance(eth, weth)]);
console.log(`done: ${formatEther(after)} ETH native, ${formatEther(afterW)} WETH; gas ${formatEther(r.gasCostWei)} ETH`);
