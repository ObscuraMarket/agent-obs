// The console walk: what a new person meets at the door and after it, checked end to end against a running API.
//
//   npm run console:walk                                   a local server on a throwaway data dir, gate off, every check
//   npm run console:walk -- --api https://obs-api.obscura.markets --key ~/.obs-test-wallet.json
//                                                          a deployed desk with a wallet on its list; read-only unless --mutate
//
// Locally it starts src/server.ts itself with the gate off and a test seed, signs in with a wallet it makes up, and
// runs every command, every bad input and the on/off/size flow, then stops the server and removes the data dir.
// Against a deployed desk it keeps to the door, the not-signed-in prompts, the read commands and the error paths,
// so the wallet's real agent is left as it was; --mutate adds the start/stop/size flow there too. It exits 1 on
// any failed check, so a deploy can gate on it. The chat path needs the gateway and is not walked here.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const args = process.argv.slice(2);
const opt = (k: string): string | null => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? null : null; };
const API_ARG = opt("--api");
const KEY_PATH = opt("--key");
const MUTATE = args.includes("--mutate");
const LOCAL = !API_ARG;
const PORT = 4799;
const API = API_ARG ?? `http://127.0.0.1:${PORT}`;

const pk = KEY_PATH ? (JSON.parse(readFileSync(KEY_PATH.replace(/^~/, process.env.HOME ?? ""), "utf8")) as { privateKey: `0x${string}` }).privateKey : generatePrivateKey();
const me = privateKeyToAccount(pk);
const stranger = privateKeyToAccount(generatePrivateKey());

type Reply = { status: number; j: Record<string, any>; lines: string[] };
const post = async (path: string, body: unknown, token?: string): Promise<Reply> => {
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  return { status: r.status, j, lines: ((j.lines ?? []) as Array<string | { text: string }>).map((l) => (typeof l === "string" ? l : l.text)) };
};
const get = async (path: string, token?: string): Promise<Reply> => {
  const r = await fetch(API + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  return { status: r.status, j, lines: [] };
};

let pass = 0;
let fail = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`); }
}
const has = (r: Reply, re: RegExp) => r.lines.some((l) => re.test(l));
const first = (r: Reply) => r.lines[0] ?? "";
const noDash = (r: Reply, name: string) => check(`${name}: no em dash in the reply`, !r.lines.some((l) => l.includes("\u2014")));

async function waitFor(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 300));
  }
  return false;
}

let server: ChildProcess | null = null;
let dataDir: string | null = null;
async function startLocal(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "obs-walk-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OBS_DATA_DIR: dataDir,
    OBS_DASHBOARD_PORT: String(PORT),
    OBS_DASHBOARD_HOST: "127.0.0.1",
    OBS_DASHBOARD_RATE_PER_MIN: "1000",
    OBS_CONSOLE_GATE: "off",
    OBS_CONSOLE_ALLOWLIST: "",
    OBS_AGENT_WALLET_SEED: "console-walk-seed-0123456789abcdef0123456789abcdef0123456789abcdef",
    OBS_FOLLOW_LIVE: "off",
    OBS_TRADING: "off",
    OBS_SESSION_SECRET: "console-walk-session-secret",
    // No gateway: the walk must not create agents on the real one for a wallet it made up.
    OPENHERMIT_GATEWAY_URL: "",
    GATEWAY_ADMIN_TOKEN: "",
    COMPOSIO_API_KEY: "",
  };
  server = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), ["src/server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr?.on("data", (b: Buffer) => { const s = b.toString(); if (/Error|error/.test(s)) process.stderr.write(`  [server] ${s.slice(0, 300)}`); });
  const up = await waitFor(`${API}/api/obs/health`, 30_000);
  if (!up) throw new Error("the local server did not come up in 30 s");
}
function stopLocal(): void {
  server?.kill("SIGTERM");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}

async function walk(): Promise<void> {
  console.log(`console walk against ${API} as ${me.address}${LOCAL ? " (local server, gate off)" : MUTATE ? " (mutating)" : " (read-only)"}`);

  console.log("door");
  const door = await get(`/api/obs/console/door?address=${me.address}`);
  const mode = String(door.j.mode ?? "");
  check("the door answers with its mode", door.status === 200 && /^(on|allowlist|off)$/.test(mode), JSON.stringify(door.j));
  check("this wallet is let in", door.j.open === true, JSON.stringify(door.j));
  const strangerDoor = await get(`/api/obs/console/door?address=${stranger.address}`);
  if (mode === "off") check("with the gate off a new wallet is let in", strangerDoor.j.open === true, JSON.stringify(strangerDoor.j));
  else check("a wallet not on the list is kept out, with the reason", strangerDoor.j.open === false && typeof strangerDoor.j.reason === "string" && strangerDoor.j.reason.length > 0, JSON.stringify(strangerDoor.j));
  const bad = await get(`/api/obs/console/door?address=0x123`);
  check("a malformed address is not let in", bad.j.open === false);
  const healthy = await get("/api/obs/health");
  check("health answers ok or stale with the alerts", (healthy.j.status === "ok" || healthy.j.status === "stale") && Array.isArray(healthy.j.alerts), JSON.stringify(healthy.j).slice(0, 200));

  console.log("not signed in");
  const help0 = await post("/api/obs/console/cli", { line: "/help" });
  check("/help lists the commands", help0.j.ok === true && has(help0, /\/start \[size\]/) && has(help0, /live from its own wallet once you fund it/));
  noDash(help0, "/help");
  const status0 = await post("/api/obs/console/cli", { line: "/status" });
  check("/status shows the desk before sign-in", status0.j.ok === true && status0.j.effect === "desk");
  for (const line of ["/start", "/wallet", "/agent", "/credits", "hello there"]) {
    const r = await post("/api/obs/console/cli", { line });
    check(`${line} asks for a wallet first`, r.j.ok === false && has(r, /^Connect your wallet first/), first(r));
  }

  if (mode !== "off") {
    console.log("stranger");
    const ch = await post("/api/obs/account/challenge", { address: stranger.address });
    if (ch.j.message) {
      const signature = await stranger.signMessage({ message: ch.j.message });
      const link = await post("/api/obs/account/link", { address: stranger.address, nonce: ch.j.nonce, signature });
      check("a wallet not on the list cannot sign in", link.status === 403 && link.j.ok === false, `${link.status} ${JSON.stringify(link.j).slice(0, 120)}`);
    } else check("a challenge is issued to any address", false, JSON.stringify(ch.j));
  }

  console.log("sign in");
  const ch = await post("/api/obs/account/challenge", { address: me.address });
  check("a challenge carries a message and a nonce", typeof ch.j.message === "string" && typeof ch.j.nonce === "string");
  const signature = await me.signMessage({ message: ch.j.message });
  const link = await post("/api/obs/account/link", { address: me.address, nonce: ch.j.nonce, signature });
  const token: string | undefined = link.j.session?.token ?? link.j.token;
  check("the signature signs in", link.status === 200 && !!token, `${link.status} ${JSON.stringify(link.j).slice(0, 120)}`);
  if (!token) return;
  const cli = (line: string) => post("/api/obs/console/cli", { line }, token);

  console.log("commands");
  const helpAll = await cli("/help all");
  check("/help all", helpAll.j.ok === true && has(helpAll, /\/withdraw/), first(helpAll));
  noDash(helpAll, "/help all");
  const whoami = await cli("/whoami");
  check("/whoami shows the setup", whoami.j.ok === true && has(whoami, /^name\s/), first(whoami));
  const status = await cli("/status");
  check("/status is the person's own agent once signed in", status.j.ok === true && status.j.effect === "follow" && /^Your agent is (on|off)/.test(first(status)), first(status));
  check("/status ends with the desk it follows", has(status, /Agent OBS, the desk it follows|\/desk shows the desk/), status.lines.join(" | ").slice(0, 200));
  const desk = await cli("/desk");
  check("/desk is the house desk", desk.j.ok === true && desk.j.effect === "desk" && has(desk, /^equity/), first(desk));
  const agents = await cli("/agents");
  check("/agents lists the followers", agents.j.ok === true && has(agents, /^agents following the desk|^No agent/), first(agents));
  const agent = await cli("/agent");
  check("/agent shows the agent", agent.j.ok === true && /^Your agent is (on|off)/.test(first(agent)), first(agent));
  const wallet = await cli("/wallet");
  check("/wallet shows the agent's wallet", wallet.j.ok === true && has(wallet, /^Your agent's wallet: 0x[0-9a-fA-F]{40}/), first(wallet));
  const credits = await cli("/credits");
  check("/credits shows the balance", credits.j.ok === true && has(credits, /^Credits:/), first(credits));
  const model = await cli("/model");
  check("/model shows the model", model.j.ok === true && has(model, /^Your agent runs on/), first(model));
  const apps = await cli("/apps");
  check("/apps answers", apps.j.ok === true, first(apps));
  const tour = await cli("/explore 5");
  check("the tour's last step says the agent trades", tour.j.ok === true && has(tour, /it trades too/), tour.lines.join(" ").slice(0, 200));
  const explore99 = await cli("/explore 99");
  check("a tour step past the end is the last step", explore99.j.ok === true && has(explore99, /^\(5\/5\)/), first(explore99));
  const foo = await cli("/foo");
  check("an unknown command says so", foo.j.ok === false && has(foo, /isn't a command/), first(foo));
  const slash = await cli("/");
  check("a bare slash points at /help", slash.j.ok === false && has(slash, /\/help/), first(slash));
  const upper = await cli("/HELP");
  check("commands are case-insensitive", upper.j.ok === true && has(upper, /\/start \[size\]/));

  console.log("bad input");
  const cases: Array<[string, RegExp]> = [
    ["/fund", /^Say how much ETH/],
    ["/fund abc", /^Say how much ETH/],
    ["/fund 0", /^Say how much ETH/],
    ["/fund 0.0001 ETH", /^The smallest funding is 0\.001 ETH/],
    ["/withdraw", /^Say how much to send back/],
    ["/withdraw 0", /^Say how much to send back/],
    ["/withdraw 0.00001", /^The smallest withdrawal is 0\.0001 ETH/],
    ["/withdraw 99 ETH", /more than that|smallest withdrawal|holds/],
    ["/size", /^Say what your agent puts into each entry/],
    ["/size 5", /^The smallest size is \$10 a trade/],
    ["/size 100000", /^The largest size is \$\d+ a trade, what the desk itself trades\.$/],
    ["/size abc", /^Say what your agent puts into each entry/],
    ["/start 5", /^The smallest size is/],
    ["/start live paper", /^Say a size in dollars/],
    ["/start foo bar baz", /^Say a size in dollars/],
    ["/reset foo", /^Put a setting back to the default/],
    ["/name", /^What should it be called/],
    ["/style", /^Pick a style/],
    ["/goal", /^Tell it what you want/],
  ];
  for (const [line, re] of cases) {
    const r = await cli(line);
    check(`${line} is refused with the right line`, r.j.ok === false && re.test(first(r)), first(r));
    noDash(r, line);
  }

  if (LOCAL || MUTATE) {
    console.log("on, size, off");
    const start = await cli("/start paper 10");
    check("/start paper 10 turns it on, on paper", start.j.ok === true && has(start, /^Your agent is on, on paper/) && has(start, /on, paper, following Agent OBS/), start.lines.join(" | ").slice(0, 200));
    const again = await cli("/start");
    check("/start again says it was already on", again.j.ok === true && has(again, /already on/), first(again));
    const size = await cli("/size 20");
    check("/size 20 sets the size", size.j.ok === true && has(size, /^\$20 a trade from here/) && has(size, /\$20 a trade/), first(size));
    const shown = await cli("/agent");
    check("/agent shows it on at $20", shown.j.ok === true && has(shown, /on, paper, following Agent OBS since \d\d:\d\dZ, \$20 a trade/), first(shown));
    const stop = await cli("/stop");
    check("/stop turns it off", stop.j.ok === true && has(stop, /^Your agent is off/), first(stop));
    const stopAgain = await cli("/stop");
    check("/stop again says it is already off", stopAgain.j.ok === true && has(stopAgain, /already off/), first(stopAgain));
    const reset = await cli("/reset chat");
    check("/reset chat clears the memory and keeps the rest", reset.j.ok === true && has(reset, /^Fresh start/), first(reset));
    const events = await get("/api/obs/my-agent/events?since=0", token);
    check("the events feed answers", events.status === 200 && Array.isArray(events.j.events));
  }

  const pub = await get("/api/obs/agents");
  check("the public agents route answers", pub.status === 200 && Array.isArray(pub.j.agents));
  const verify = await post("/api/obs/my-agent/wallet/verify", { txHash: "0x" + "ab".repeat(32) }, token);
  check("a funding that is not on the chain is refused, not recorded", verify.status === 409 && verify.j.ok === false, `${verify.status} ${JSON.stringify(verify.j).slice(0, 120)}`);
}

try {
  if (LOCAL) await startLocal();
  await walk();
} catch (e) {
  fail++;
  failed.push(`the walk stopped: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (LOCAL) stopLocal();
}
console.log(`\n${pass} passed, ${fail} failed${failed.length ? `:\n  ${failed.join("\n  ")}` : ""}`);
process.exit(fail ? 1 : 0);
