// The console's router: one typed line in, a plain object out. Pure: nothing here reads the network, the clock or
// a request. The route applies the effect with the wallet session; this module only decides, and it can be tested
// by calling it. That split matters because a command surface is user text deciding which capability runs.
//
// A line without a leading slash is something to say to your agent. A line with one is a command: shaping your
// agent, reading the desk, or using your wallet. Every settings change is an intent the route applies through the
// same validator the settings route uses, never a write from here.
import { STYLES, DEFAULT_NAME, type UserSettings } from "../desk/userSettings.ts";

export type DeskCommand = "status" | "positions" | "thoughts" | "research" | "watch" | "reads" | "agents";

/** The site's own pages the console opens beside itself, one command each. They left the header for this; their routes stay for deep links. */
export type ConsoleView = "trade" | "rewards" | "cards" | "yield";
export const VIEWS: ConsoleView[] = ["trade", "rewards", "cards", "yield"];
const VIEW_ALIAS: Record<string, ConsoleView> = { app: "trade", exchange: "trade", reward: "rewards", card: "cards" };
const VIEW_LINE: Record<ConsoleView, string> = {
  trade: "Trade is open beside the console: swap through Obscura's routes, with the same privacy as the Trade page. /close puts it away.",
  rewards: "Rewards is open beside the console: your cashback in tokenized stocks. /close puts it away.",
  cards: "Cards is open beside the console: the Obscura card. /close puts it away.",
  yield: "Yield is coming soon, and its waitlist is open beside the console. /close puts it away.",
};

export type ConsoleEffect =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "chat"; text: string }
  | { kind: "desk"; command: DeskCommand; n?: number; /** /desk: the house desk's status even when signed in, where /status is the person's own agent. */ house?: boolean }
  | { kind: "read"; what: "whoami" | "swaps" }
  /** The signal ledger's latest board, the operator's read: the route keeps it behind the bearer and OBS_CONSOLE_ALLOWLIST, off every public route. */
  | { kind: "signals"; n?: number }
  | { kind: "settings"; patch: Record<string, unknown> }
  /** Client-side: the wallet does these. The route only echoes them back. */
  | { kind: "wallet"; action: "connect" | "balance" }
  | { kind: "wallet"; action: "quote" | "swap"; amount: number; from: string; to: string }
  /** Client-side: the page opens one of the site's own pages beside the console, or closes it (null). */
  | { kind: "view"; view: ConsoleView | null }
  /** The person's apps, through Composio: what is connected, connect one, disconnect one. */
  | { kind: "apps"; action: "list" | "connect" | "disconnect"; app?: string }
  /** The model the agent runs on: show it, search the catalog, or pick one. */
  | { kind: "model"; action: "show" | "list" | "set"; query?: string }
  /** Credits: the balance, or a payment to sign. */
  | { kind: "credits"; action: "show" | "buy"; amount?: number; token?: string }
  /** The wallet's own trading agent, which follows the desk: turn it on (with a size), off, resize it, or show its book. */
  | { kind: "follow"; action: "start" | "stop" | "size" | "show"; sizeUsd?: number; mode?: "paper" | "live" }
  /** The agent's own wallet: show it, fund it from the person's wallet (they sign), send ETH back to their wallet, or a token it holds: sent back whole (withdrawToken) or sold whole for ETH (sell). */
  | { kind: "agentWallet"; action: "show" | "fund" | "withdraw" | "withdrawToken" | "sell"; amount?: number; all?: boolean; symbol?: string };

export interface ConsoleResult {
  lines: string[];
  effect: ConsoleEffect;
  error?: boolean;
  /** One-tap next steps: literal lines to submit, a command or a message. */
  suggest?: string[];
}

export interface ConsoleContext {
  settings: UserSettings;
  /** Whether a wallet is signed in: the suggestions point at /connect until it is. */
  signedIn: boolean;
  /** Swaps this wallet has made through the console; shown, never a gate. */
  swaps: number;
  /** Whether apps (Composio) are switched on here: the help and /apps say "coming" until they are. Missing means on. */
  apps?: boolean;
  /** How the door is kept, for the wording: holders (on), the operator's list only (allowlist), or everyone (off). */
  gate?: "on" | "allowlist" | "off";
}

const ok = (lines: string[], effect: ConsoleEffect = { kind: "none" }, suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect, suggest } : { lines, effect });
const err = (lines: string[], suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect: { kind: "none" }, error: true, suggest } : { lines, effect: { kind: "none" }, error: true });

const DESK: DeskCommand[] = ["status", "positions", "thoughts", "research", "watch", "reads", "agents"];
const DESK_ALIAS: Record<string, DeskCommand> = { book: "positions", thought: "thoughts", log: "research", live: "watch", read: "reads", leaderboard: "agents", board: "agents", followers: "agents" };

type Door = Pick<ConsoleContext, "apps" | "gate">;

/** PURE: what connecting gets you, as the door stands: holders, the operator's list, or anyone. */
export const connectLine = (gate: ConsoleContext["gate"]): string =>
  gate === "allowlist" ? "Connect an invited wallet and get an agent of your own to talk to and train"
  : gate === "off" ? "Connect your wallet and get an agent of your own to talk to and train"
  : "Connect a wallet holding OBS or AOBS and get an agent of your own to talk to and train";

/** PURE: the short help, worded for the door as it is; the /apps line only while apps are switched on. */
export function helpLines(door: Door = {}): string[] {
  return [
    "Type a message to talk to your agent, or start a line with / for a command.",
    "",
    "  /explore           A short tour, one step at a time",
    "  /status            Your own agent's status once you're signed in; the desk's until then",
    "  /desk              What Agent OBS, the house desk, is doing right now",
    "  /agents            Every agent following the desk: who is on, what they hold, what they made",
    "  /trade /rewards /cards /yield   Open a page of the app beside the console",
    "  /swap 0.05 ETH USDG   Swap from your own wallet through the pools",
    `  /connect           ${connectLine(door.gate)}`,
    "  /start [size]      Turn your trading agent on: it follows every trade Agent OBS makes, at your size, live from its own wallet once you fund it. /stop, /agent",
    "  /size 150          What it puts into each entry, in dollars; change it any time",
    "  /wallet            Your agent's own wallet: /fund 0.05 ETH puts ETH in from your wallet, /withdraw all takes it back; /withdraw LENNY or /sell LENNY for a token it holds",
    ...(door.apps === false ? [] : ["  /apps              Connect Slack, Linear, X, Gmail, Google Docs and more to your agent"]),
    "  /model             Pick the model your agent runs on, any of them",
    "  /credits           Your credits, and how to add some with ETH, USDG, AOBS or a tokenized stock",
    "",
    "  /help all          Every command",
  ];
}
export const HELP = helpLines();

/** PURE: every command; the apps section only while apps are switched on. */
export function helpAllLines(door: Door = {}): string[] {
  return [
  "Every command. Anything without a slash is a message to your agent.",
  "",
  "  Your agent (it belongs to the wallet you connected; that wallet controls it. Train it here:)",
  "    /whoami            How it's set up right now",
  "    /name <name>       Give it a name",
  "    /style <style>     concise, balanced or deep",
  "    /voice <text>      How it should sound: dry, warm, blunt, your call",
  "    /goal <text>       What you want from it",
  "    /reset <field>     Put one setting back to the default; /reset chat gives it a fresh memory, everything taught stays",
  "    /model [name]      Pick the model it runs on, from every model OpenRouter serves; /models <search> finds one",
  "    /credits           Your balance; /credits buy 10 USDG adds credits (also ETH, AOBS, or a tokenized stock like NVDA)",
  "",
  ...(door.apps === false ? [] : [
  "  Your apps (your agent gets their tools, and asks you before it acts in one)",
  "    /apps              What's connected, and what can be",
  "    /apps connect <app>     Connect one: Slack, Linear, X, Gmail, Google Docs, Sheets, Calendar, Notion, GitHub",
  "    /apps disconnect <app>  Take one away",
  "",
  ]),
  "  Your trading agent (it follows Agent OBS: every entry and exit the desk makes, at your size; it never trades on its own)",
  "    /start [size]      Turn it on, from this moment; live from its own wallet once you fund it, on paper until then",
  "    /stop              Turn it off; it still sells what it holds when the desk does",
  "    /size <usd>        What it puts into each entry, up to what the desk itself trades",
  "    /agent             Its book: on or off, what it holds, what it has made",
  "    /wallet            Its own wallet, made for it and held by the desk: where it is and what it holds",
  "    /fund 0.05 ETH     Put ETH in from your wallet; you sign the transfer",
  "    /withdraw all      Send it back to your wallet, or a part: /withdraw 0.02; it can only ever go to the wallet you signed in with",
  "    /withdraw LENNY    Send a token it holds to your wallet, all of it",
  "    /sell LENNY        Sell a token it holds for ETH, all of it, through the pools the desk uses; for a token the desk did not sell",
  "",
  "  The app (opens beside the console; /close puts it away)",
  "    /trade             Swap through Obscura's routes",
  "    /rewards           Your cashback in tokenized stocks",
  "    /cards             The Obscura card",
    "    /yield             Coming soon, with its waitlist",
  "",
  "  The desk (live, read only)",
  "    /desk              What Agent OBS is doing right now (/status is your own agent once you're signed in)",
  "    /agents            Every agent following the desk, in public: on or off, live or paper, what they hold, what they made",
  "    /positions /thoughts [n] /research [n] /watch /reads",
  "    /signals [n]       The board the desk wrote when it last thought: each token's reads and the desk's stance on it; the operator's wallets only",
  "",
  "  Your wallet",
  "    /connect           Connect your wallet: your account here, and the wallet that controls your agent",
  "    /balance           The ETH in it",
  "    /quote 0.05 ETH USDG   What the pools pay, with the app's Relay route beside it",
  "    /swap 0.05 ETH USDG    The same swap, signed by your wallet and paid to your address",
  "    /swaps             The swaps you've made through the console",
  "",
  "  Session",
  "    /explore /clear /help",
  "",
  "  Talking to your agent is free, and so is every command.",
  ];
}
export const HELP_ALL = helpAllLines();

/** PURE: the tour: what this is, whether to take its word, how to check, then the parts that need a wallet. The last step is worded for the door. */
export function tourFor(door: Door = {}): Array<{ title: string; lines: string[]; tryIt: string }> {
  const who = door.gate === "allowlist" ? "Connect an invited wallet" : door.gate === "off" ? "Connect your wallet" : "Connect a wallet holding OBS or AOBS";
  return [
    { title: "This is a live desk", lines: ["Agent OBS trades from its own wallet on Robinhood Chain and thinks out loud.", "Every cycle it records what it read, what it made of it, and what it decided."], tryIt: "/status" },
    { title: "Read it, don't take its word", lines: ["Every number on the page comes from a read the desk made. The thoughts are its own words;", "the research log is what it read between cycles."], tryIt: "/thoughts 2" },
    { title: "Quote through the pools", lines: ["The desk quotes the pools directly, where every swap on this chain settles, and shows", "the app's Relay route beside it, so you can see the spread for yourself."], tryIt: "/quote 0.05 ETH USDG" },
    { title: "Swap from your own wallet", lines: ["Your wallet signs, the swap pays your address in the same transaction, and the desk", "reads it off the chain. Nothing is ever held for you."], tryIt: "/swap 0.05 ETH USDG" },
    { title: "An agent of your own", lines: [`${who} and you get a basic agent, like any other assistant,`, "that you train right here: name it, set its style and voice, tell it what you want. It remembers", "your conversation and belongs to the wallet you connected, which controls it. Turn it on with /start and it trades too:", "every trade Agent OBS makes, at your size, from its own wallet once you fund it."], tryIt: "/connect" },
  ];
}
export const TOUR = tourFor();

const list = (xs: readonly string[]) => xs.join(" | ");
/** PURE: a token named on its own, or after "all", as the symbol the desk resolves it by; null for anything else. */
const tokenArg = (arg: string): string | null => {
  const m = arg.match(/^(?:all\s+)?([A-Za-z0-9]{1,20})$/i);
  return m ? m[1].toUpperCase() : null;
};

/** PURE: route one line against the wallet's current settings and standing. Never mutates either. */
export function routeConsole(raw: string, ctx: ConsoleContext): ConsoleResult {
  const line = (raw ?? "").trim();
  if (!line) return ok([]);
  if (!line.startsWith("/")) return ok([], { kind: "chat", text: line });

  const [head, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  const s = ctx.settings;

  switch (cmd) {
    case "":
      return err(["Type /help to see what you can do."], ["/help"]);
    case "help":
    case "?":
      if (arg.toLowerCase() === "all") return ok(helpAllLines(ctx));
      return ok(helpLines(ctx), { kind: "none" }, ["/explore", "/status", ctx.signedIn ? "/whoami" : "/connect"]);
    case "clear":
      return ok([], { kind: "clear" });
    case "explore":
    case "tour": {
      const tour = tourFor(ctx);
      const step = Math.max(1, Math.min(tour.length, parseInt(arg, 10) || 1));
      const t = tour[step - 1];
      const last = step >= tour.length;
      return ok([`(${step}/${tour.length}) ${t.title}`, ``, ...t.lines, ...(last ? [``, `That's the tour. /help has the full list whenever you want it.`] : [])], { kind: "none" }, last ? [t.tryIt] : [t.tryIt, `/explore ${step + 1}`]);
    }
    case "desk":
    case "obs":
    case "house":
      return ok([], { kind: "desk", command: "status", house: true });
    case "wallet":
      return ok([], { kind: "agentWallet", action: "show" });
    case "fund": {
      const m = arg.match(/^([\d,]*\d(?:\.\d+)?)\s*(eth)?$/i);
      const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
      if (!m || !(amount > 0)) return err(["Say how much ETH to send to your agent's wallet: /fund 0.05 ETH"], ["/fund 0.05 ETH", "/wallet"]);
      return ok([], { kind: "agentWallet", action: "fund", amount });
    }
    case "withdraw": {
      if (/^all$/i.test(arg)) return ok([], { kind: "agentWallet", action: "withdraw", all: true });
      const m = arg.match(/^([\d,]*\d(?:\.\d+)?)\s*(eth)?$/i);
      if (m) {
        const amount = Number(m[1].replace(/,/g, ""));
        if (!(amount > 0)) return err(["Say how much to send back to your wallet: /withdraw 0.02 ETH, or /withdraw all"], ["/withdraw all", "/wallet"]);
        return ok([], { kind: "agentWallet", action: "withdraw", amount });
      }
      // A symbol with no amount is a token the agent holds, sent out whole; "all LENNY" says the same thing.
      const symbol = tokenArg(arg);
      if (symbol === "ETH") return err(["ETH goes by amount: /withdraw 0.02 or /withdraw all."], ["/withdraw all", "/wallet"]);
      if (symbol) return ok([], { kind: "agentWallet", action: "withdrawToken", symbol });
      return err(["Say how much to send back to your wallet: /withdraw 0.02 ETH, or /withdraw all; or a token your agent holds: /withdraw LENNY"], ["/withdraw all", "/wallet"]);
    }
    case "sell": {
      const symbol = tokenArg(arg);
      if (!symbol) return err(["Say which token your agent should sell for ETH, all of it: /sell LENNY"], ["/agent", "/wallet"]);
      if (symbol === "ETH") return err(["ETH is what it sells into. /withdraw 0.02 or /withdraw all takes ETH out."], ["/withdraw all", "/agent"]);
      return ok([], { kind: "agentWallet", action: "sell", symbol });
    }
    case "start":
    case "on": {
      // /start, /start 150, /start live, /start paper 100: the mode word is optional and so is the size.
      const words = arg.split(/\s+/).filter(Boolean);
      const mode = words.find((w) => /^(live|paper)$/i.test(w))?.toLowerCase() as "live" | "paper" | undefined;
      const sizeWord = words.find((w) => !/^(live|paper)$/i.test(w));
      if (words.length > (mode ? 1 : 0) + (sizeWord ? 1 : 0)) return err(["Say a size in dollars, and live or paper if you want to choose: /start 150, /start live, /start paper 100"], ["/start", "/start 100"]);
      if (!sizeWord) return ok([], { kind: "follow", action: "start", ...(mode ? { mode } : {}) });
      const n = Number(sizeWord.replace(/[$,]/g, ""));
      if (!Number.isFinite(n)) return err(["Say a size in dollars, or nothing for your current size: /start 100"], ["/start", "/start 100"]);
      return ok([], { kind: "follow", action: "start", sizeUsd: n, ...(mode ? { mode } : {}) });
    }
    case "stop":
    case "off":
      return ok([], { kind: "follow", action: "stop" });
    case "size": {
      const n = Number(arg.replace(/[$,]/g, ""));
      if (!arg || !Number.isFinite(n)) return err(["Say what your agent puts into each entry, in dollars: /size 100"], ["/size 100", "/agent"]);
      return ok([], { kind: "follow", action: "size", sizeUsd: n });
    }
    case "agent":
    case "follow":
    case "trading":
      return ok([], { kind: "follow", action: "show" });
    case "whoami":
    case "settings":
      return ok([], { kind: "read", what: "whoami" });
    case "swaps":
    case "eligible":
    case "progress":
      return ok([], { kind: "read", what: "swaps" });
    case "signals":
    case "signal": {
      // The board the desk wrote when it last thought; n caps the rows. The route answers it only to a signed-in
      // wallet on the operator's list (OBS_CONSOLE_ALLOWLIST), whatever the gate mode, and never puts it on a
      // public route: the strong rows are what the convoy acts on, and a holder polling them would run ahead of
      // it (review of 2026-09-08).
      const n = /^\d+$/.test(arg) ? Number(arg) : undefined;
      return ok([], { kind: "signals", ...(n != null ? { n } : {}) });
    }
    case "connect":
    case "balance":
      return ok([], { kind: "wallet", action: cmd });
    case "quote":
    case "swap": {
      const m = arg.match(/^([\d,]*\d(?:\.\d+)?)\s+([A-Za-z0-9]+)\s*(?:->|to|for)?\s+([A-Za-z0-9]+)$/i);
      const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
      if (!m || !(amount > 0)) return err([`Say how much and which pair: /${cmd} <amount> <FROM> <TO>`, `  For example: /${cmd} 0.05 ETH USDG`], [`/${cmd} 0.05 ETH USDG`]);
      return ok([], { kind: "wallet", action: cmd, amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() });
    }
    case "name":
      if (!arg) return err(["What should it be called? /name <name>", `Right now: ${s.name ?? `${DEFAULT_NAME} (the default)`}`]);
      return ok([], { kind: "settings", patch: { name: arg } });
    case "style": {
      const v = arg.toLowerCase();
      if (!v) return err([`Pick a style: /style ${list(STYLES)}`, `Right now: ${s.style ?? "balanced (the default)"}`]);
      if (!STYLES.includes(v as never)) return err([`"${arg}" isn't a style. Pick one of ${list(STYLES)}.`], STYLES.map((x) => `/style ${x}`));
      return ok([], { kind: "settings", patch: { style: v } });
    }
    case "voice":
      if (!arg) return err(["Tell it how to sound: /voice <a few words>", `Right now: ${s.voice ?? "not set"}`, `  For example: /voice dry and skeptical, never enthusiastic`]);
      return ok([], { kind: "settings", patch: { voice: arg } });
    case "goal":
      if (!arg) return err(["Tell it what you want from it: /goal <a sentence>", `Right now: ${s.goal ?? "not set"}`]);
      return ok([], { kind: "settings", patch: { goal: arg } });
    case "reset": {
      const f = arg.toLowerCase();
      // /reset chat: a fresh memory for the agent, a new session on the gateway; what was taught (name, style, voice, goal, model) stays.
      const fields: Record<string, Record<string, unknown>> = { name: { name: "" }, goal: { goal: "" }, voice: { voice: "" }, style: { style: "balanced" }, model: { model: "" }, chat: { chatGen: (s.chatGen ?? 0) + 1 } };
      if (!f || !(f in fields)) return err([`Put a setting back to the default: /reset ${Object.keys(fields).join(", /reset ")}`]);
      return ok([], { kind: "settings", patch: fields[f] });
    }
    case "model":
    case "models": {
      const [sub, ...rw] = arg.split(/\s+/);
      const s2 = (sub ?? "").toLowerCase();
      if (cmd === "models" || s2 === "list" || s2 === "search" || s2 === "find") return ok([], { kind: "model", action: "list", query: (cmd === "models" ? arg : rw.join(" ")).trim() });
      if (!arg) return ok([], { kind: "model", action: "show" });
      return ok([], { kind: "model", action: "set", query: arg });
    }
    case "credits":
    case "buy": {
      const text = cmd === "buy" ? arg : arg.replace(/^(?:buy|add|top\s*up)\s*/i, "");
      if (cmd === "credits" && !arg) return ok([], { kind: "credits", action: "show" });
      const m = text.match(/^([\d,]*\d(?:\.\d+)?)\s+(?:rh\s+)?([A-Za-z0-9]+)$/i);
      const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
      if (!m || !(amount > 0)) return err(["Add credits with an amount and a token: /credits buy 10 USDG", "  Also ETH, AOBS, or a tokenized stock like NVDA."], ["/credits buy 10 USDG", "/credits"]);
      return ok([], { kind: "credits", action: "buy", amount, token: m[2].toUpperCase() });
    }
    case "apps":
    case "integrations": {
      // Composio is not switched on here yet: say so plainly rather than sending the effect to a route that will.
      if (ctx.apps === false) return ok(["Apps are coming later: Slack, Linear, X, Gmail and Google Docs will connect to your agent right here. Nothing to set up yet."], { kind: "none" }, ["/help", "/model"]);
      const [sub, ...restWords] = arg.split(/\s+/);
      const s2 = (sub ?? "").toLowerCase();
      const app = restWords.join(" ").trim();
      if (!s2 || s2 === "list") return ok([], { kind: "apps", action: "list" });
      if (s2 === "connect" || s2 === "add" || s2 === "link") return app ? ok([], { kind: "apps", action: "connect", app }) : err(["Which app? /apps connect Slack"], ["/apps"]);
      if (s2 === "disconnect" || s2 === "remove" || s2 === "unlink") return app ? ok([], { kind: "apps", action: "disconnect", app }) : err(["Which app? /apps disconnect Slack"], ["/apps"]);
      return ok([], { kind: "apps", action: "connect", app: arg });
    }
    case "close":
    case "back":
      return ok(["Closed."], { kind: "view", view: null }, ["/trade", "/help"]);
    default: {
      const view = VIEWS.includes(cmd as ConsoleView) ? (cmd as ConsoleView) : VIEW_ALIAS[cmd];
      if (view) return ok([VIEW_LINE[view]], { kind: "view", view }, [...VIEWS.filter((v) => v !== view).slice(0, 2).map((v) => `/${v}`), "/close"]);
      const desk = DESK.includes(cmd as DeskCommand) ? (cmd as DeskCommand) : DESK_ALIAS[cmd];
      if (desk) {
        const n = /^\d+$/.test(arg) ? Number(arg) : undefined;
        return ok([], { kind: "desk", command: desk, ...(n != null ? { n } : {}) });
      }
      const near = suggest(cmd);
      return err(near.length ? [`"/${cmd}" isn't a command. Did you mean ${near[0]}?`] : [`"/${cmd}" isn't a command. /help lists them.`], near.length ? near : ["/help"]);
    }
  }
}

export const VOCAB = ["help", "explore", "clear", "whoami", "name", "style", "voice", "goal", "reset", "model", "models", "credits", "buy", "swaps", "apps", "connect", "balance", "quote", "swap", "start", "stop", "size", "agent", "wallet", "fund", "withdraw", "sell", "desk", "signals", ...VIEWS, "close", ...DESK];

/** PURE: one near miss for a typo, by edit distance, only when it is actually close. */
export function suggest(cmd: string): string[] {
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of VOCAB) {
    const d = distance(cmd, v);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best && bestD <= 2 ? [`/${best}`] : [];
}

function distance(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
