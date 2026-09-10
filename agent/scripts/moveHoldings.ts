// Move the desk's holdings from the wallet it trades from now to another wallet the operator names, as ONE user
// operation through the account-abstraction lane (OBS_EXEC=aa, aa.ts): WETH unwrapped and sent on as native ETH,
// since a plain wallet needs native ETH for swap value and gas, and the agent token sent as it is. Run inside the
// desk with trading off, BEFORE the desk's key is switched to the new wallet: only the current key signs for these.
//   npm run move:holdings -- <to 0x...> --eth <amount|all|0> --aobs <amount|all|0>          dry: reads, builds, simulates
//   npm run move:holdings -- <to 0x...> --eth all --aobs all --now                            sends it
// Addresses and amounts only; no key is ever printed.
import { createPublicClient, encodeFunctionData, formatEther, getAddress, http, parseAbi, parseEther } from "viem";
import { AGENT_TOKEN, RPC_URL, WALLET_ADDRESS, WETH_CONTRACT } from "../src/config.ts";
import { ASSETS } from "../src/desk/assets.ts";
import { readNativeBalance, readTokenBalance } from "../src/desk/signer.ts";
import { railsFromEnv } from "../src/desk/rails.ts";
import { aaOn, buildUserOp, depositMinWei, depositTopUpWei, ensureDeposit, formatGasPlan, sendUserOp, simulateBatch, simulateUserOp, spendableEthRaw, wethWithdrawData, type AaCall } from "../src/desk/aa.ts";

const args = process.argv.slice(2);
const live = args.includes("--now");
const flag = (name: string): string | null => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const fail = (why: string): never => { console.error(why); process.exit(1); };
const usage = "usage: npm run move:holdings -- <to 0x...> --eth <amount|all|0> --aobs <amount|all|0> [--now]";

const toArg = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? fail(usage);
const to = getAddress(toArg);
const from = WALLET_ADDRESS as `0x${string}`;
if (!from) fail("no OBS_WALLET_ADDRESS configured");
if (to.toLowerCase() === from.toLowerCase()) fail("the destination is the wallet the desk trades from now");
if (!aaOn()) fail("OBS_EXEC is not aa: this moves funds out through the account-abstraction lane, which is only set up while the desk still trades from the current wallet");
if (railsFromEnv().tradingOn) fail("trading is on (OBS_TRADING=on); switch it off before moving the desk's holdings");
const ethArg = flag("--eth");
const aobsArg = flag("--aobs");
if (ethArg == null || aobsArg == null) fail(`name both amounts. ${usage}`);

// A plain wallet only: code at the destination means a contract or a delegated account, which is not what this is for.
const client = createPublicClient({ transport: http(RPC_URL) });
const code = await client.getCode({ address: to });
if (code && code !== "0x") fail(`${to} has contract code (${(code.length - 2) / 2} bytes); this sends to a plain wallet only`);

const eth = ASSETS["ETH@robinhood"];
const aobsToken = AGENT_TOKEN as `0x${string}`;
const weth = WETH_CONTRACT as `0x${string}`;
const spend = await spendableEthRaw(from);
const aobsHeld = await readTokenBalance(eth, aobsToken, from);
console.log(`from ${from}: ${formatEther(spend.native)} ETH native, ${formatEther(spend.weth)} WETH, ${formatEther(aobsHeld)} AOBS`);
console.log(`to   ${to}: plain wallet (no code)`);

const ethRaw = ethArg === "all" ? spend.total : parseEther(ethArg);
if (ethRaw > spend.total) fail(`--eth ${ethArg} is more than the ${formatEther(spend.total)} ETH (native plus WETH) the wallet holds`);
const withdrawRaw = ethRaw > spend.native ? ethRaw - spend.native : 0n;
const aobsRaw = aobsArg === "all" ? aobsHeld : parseEther(aobsArg);
if (aobsRaw > aobsHeld) fail(`--aobs ${aobsArg} is more than the ${formatEther(aobsHeld)} AOBS the wallet holds`);

const calls: AaCall[] = [];
if (withdrawRaw > 0n) calls.push({ to: weth, value: 0n, data: wethWithdrawData(withdrawRaw) });
if (ethRaw > 0n) calls.push({ to, value: ethRaw, data: "0x" });
if (aobsRaw > 0n) calls.push({ to: aobsToken, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [to, aobsRaw] }) });
if (!calls.length) fail("nothing to move: both amounts are zero");
console.log(`plan: ${[withdrawRaw > 0n ? `WETH.withdraw(${formatEther(withdrawRaw)})` : null, ethRaw > 0n ? `send ${formatEther(ethRaw)} ETH` : null, aobsRaw > 0n ? `AOBS.transfer(${formatEther(aobsRaw)})` : null].filter(Boolean).join(", then ")}, as one user operation`);

const inner = await simulateBatch(calls);
console.log(inner.ok ? "batch simulation as a self-call: OK" : `batch simulation as a self-call: REVERT: ${inner.reason}`);
if (!inner.ok) process.exit(1);

if (!live) {
  try {
    const p = await buildUserOp(calls);
    console.log(`user operation ${p.userOpHash}: ${formatGasPlan(p.gas)}`);
    const sim = await simulateUserOp(p);
    console.log(sim.ok ? "handleOps simulation from the gas wallet: OK" : `handleOps simulation from the gas wallet: ${sim.reason}`);
  } catch (e) {
    console.log(`the operation could not be built: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  console.log("\ndry: nothing sent. Add --now to send it.");
  process.exit(0);
}

const d = await ensureDeposit(depositMinWei(), depositTopUpWei());
if (d.hash) console.log(`entry point deposit topped up ${formatEther(d.before)} to ${formatEther(d.after)} ETH (${d.hash})`);
const p = await buildUserOp(calls);
const sim = await simulateUserOp(p);
if (!sim.ok) fail(`handleOps simulation from the gas wallet: ${sim.reason}; nothing sent`);
const r = await sendUserOp(p);
console.log(`handleOps ${r.hash}: success ${r.success}${r.revert ? ` (batch reverted: ${r.revert})` : ""}`);
const [fromAfter, toNative, toAobs, fromAobs] = await Promise.all([spendableEthRaw(from), readNativeBalance(eth, to), readTokenBalance(eth, aobsToken, to), readTokenBalance(eth, aobsToken, from)]);
console.log(`from after: ${formatEther(fromAfter.native)} ETH native, ${formatEther(fromAfter.weth)} WETH, ${formatEther(fromAobs)} AOBS`);
console.log(`to after:   ${formatEther(toNative)} ETH native, ${formatEther(toAobs)} AOBS`);
process.exit(r.success ? 0 : 1);
