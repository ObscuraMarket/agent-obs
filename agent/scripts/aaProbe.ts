// The proof of the account-abstraction lane (OBS_EXEC=aa; src/desk/aa.ts), run inside the desk where both key
// files are: one user operation from the trading wallet, executeBatch([WETH.withdraw(0.001 ETH),
// WETH.deposit{value: 0.001 ETH}]), a round trip that proves execution and value flow through the delegated
// account without changing the wallet's balances beyond gas. The gas wallet sends it and pays for it.
//   npm run aa:probe            reads, builds and simulates; nothing is sent
//   npm run aa:probe -- --now   tops up the entry point deposit when it is short, sends the round trip, prints the receipt
// Without --now the handleOps simulation is expected to say AA21 (no prefund) while the deposit is empty: the
// deposit is only funded with --now. Addresses only; no key is ever printed.
import { formatEther, parseEther } from "viem";
import { WALLET_ADDRESS, WETH_CONTRACT } from "../src/config.ts";
import { ASSETS } from "../src/desk/assets.ts";
import { readNativeBalance } from "../src/desk/signer.ts";
import { buildUserOp, simulateBatch, simulateUserOp, sendUserOp, entryPointDeposit, ensureDeposit, loadGasAccount, wethWithdrawData, wethDepositData, spendableEthRaw, depositMinWei, depositTopUpWei, prefundWei, formatGasPlan, DESK_NONCE_KEY, ENTRY_POINT, type AaCall } from "../src/desk/aa.ts";

const live = process.argv.includes("--now");
const AMOUNT = parseEther("0.001");
const eth = ASSETS["ETH@robinhood"];
const weth = WETH_CONTRACT as `0x${string}`;
const fail = (why: string): never => { console.error(why); process.exit(1); };
if (!WALLET_ADDRESS) fail("no OBS_WALLET_ADDRESS configured");
const gas = loadGasAccount();
const min = depositMinWei();
const topUp = depositTopUpWei();

const readAll = async () => {
  const [spend, gasNative, deposit] = await Promise.all([spendableEthRaw(), readNativeBalance(eth, gas.address), entryPointDeposit()]);
  return { spend, gasNative, deposit };
};
const before = await readAll();
console.log(`trading wallet ${WALLET_ADDRESS}: ${formatEther(before.spend.native)} ETH native, ${formatEther(before.spend.weth)} WETH; entry point deposit ${formatEther(before.deposit)} ETH (EntryPoint ${ENTRY_POINT})`);
console.log(`gas wallet ${gas.address}: ${formatEther(before.gasNative)} ETH native`);
console.log(`nonce key 0x${DESK_NONCE_KEY.toString(16)}; deposit floor ${formatEther(min)} ETH, top-up ${formatEther(topUp)} ETH`);
if (before.spend.weth < AMOUNT) fail(`the wallet holds ${formatEther(before.spend.weth)} WETH, under the ${formatEther(AMOUNT)} the round trip moves`);

const calls: AaCall[] = [
  { to: weth, value: 0n, data: wethWithdrawData(AMOUNT) },
  { to: weth, value: AMOUNT, data: wethDepositData() },
];
const inner = await simulateBatch(calls);
console.log(inner.ok ? "batch simulation as a self-call: OK (withdraw, then deposit with value)" : `batch simulation as a self-call: REVERT: ${inner.reason}`);
if (!inner.ok) process.exit(1);

if (!live) {
  console.log(before.deposit < min ? `the deposit is under the floor: with --now the gas wallet would send depositTo(wallet) with ${formatEther(topUp)} ETH first` : "the deposit covers the floor; no top-up needed");
  try {
    const p = await buildUserOp(calls);
    console.log(`user operation ${p.userOpHash}: nonce ${p.op.nonce}, gas ${formatGasPlan(p.gas)}`);
    const sim = await simulateUserOp(p);
    console.log(sim.ok ? "handleOps simulation from the gas wallet: OK" : `handleOps simulation from the gas wallet: ${sim.reason}${before.deposit < prefundWei(p.gas) ? " (expected while the deposit is under the prefund; --now funds it first)" : ""}`);
  } catch (e) {
    console.log(`the operation could not be built: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  console.log("dry: nothing sent. Run with --now to fund the deposit and send the round trip.");
  process.exit(0);
}

const d = await ensureDeposit(min, topUp);
console.log(d.hash ? `deposit topped up ${formatEther(d.before)} to ${formatEther(d.after)} ETH (${d.hash})` : `deposit ${formatEther(d.before)} ETH covers the floor`);
const p = await buildUserOp(calls);
console.log(`user operation ${p.userOpHash}: nonce ${p.op.nonce}, gas ${formatGasPlan(p.gas)}`);
const sim = await simulateUserOp(p);
if (!sim.ok) fail(`handleOps simulation from the gas wallet: ${sim.reason}; nothing sent`);
console.log("handleOps simulation from the gas wallet: OK; sending");
const r = await sendUserOp(p);
console.log(`handleOps ${r.hash}: success ${r.success}${r.revert ? ` (batch reverted: ${r.revert})` : ""}; outer gas ${formatEther(r.gasCostWei)} ETH paid by the gas wallet, actualGasCost ${formatEther(r.actualGasCost)} ETH drawn from the deposit and paid to it`);
const after = await readAll();
console.log(`trading wallet after: ${formatEther(after.spend.native)} ETH native, ${formatEther(after.spend.weth)} WETH (${formatEther(after.spend.total - before.spend.total)} ETH change); deposit ${formatEther(after.deposit)} ETH (${formatEther(after.deposit - d.after)} change)`);
console.log(`gas wallet after: ${formatEther(after.gasNative)} ETH (${formatEther(after.gasNative - before.gasNative)} change, the deposit top-up included)`);
process.exit(r.success ? 0 : 1);
