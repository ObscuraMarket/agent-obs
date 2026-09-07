// The console's router: one typed line in, a plain object out. Pure: nothing here reads the network, the clock or
// a request. The route applies the effect with the wallet session; this module only decides, and it can be tested
// by calling it. That split matters because a command surface is user text deciding which capability runs.
//
// A line without a leading slash is something to say to your agent. A line with one is a command: shaping your
// agent, reading the desk, or using your wallet. Every settings change is an intent the route applies through the
// same validator the settings route uses, never a write from here.
import { STYLES, DEFAULT_NAME, type UserSettings } from "../desk/userSettings.ts";

export type DeskCommand = "status" | "positions" | "thoughts" | "research" | "watch" | "reads";

/** The site's own pages the console opens beside itself, one command each. They left the header for this; their routes stay for deep links. */
export type ConsoleView = "trade" | "rewards" | "cards" | "referral" | "yield";
export const VIEWS: ConsoleView[] = ["trade", "rewards", "cards", "referral", "yield"];
const VIEW_ALIAS: Record<string, ConsoleView> = { app: "trade", exchange: "trade", reward: "rewards", card: "cards", refer: "referral", referrals: "referral" };
const VIEW_LINE: Record<ConsoleView, string> = {
  trade: "Trade is open beside the console: swap through Obscura's routes, with the same privacy as the Trade page. /close puts it away.",
  rewards: "Rewards is open beside the console: your cashback in tokenized stocks. /close puts it away.",
  cards: "Cards is open beside the console: the Obscura card. /close puts it away.",
  referral: "Referral is open beside the console: the referral waitlist. /close puts it away.",
  yield: "Yield is coming soon, and its waitlist is open beside the console. /close puts it away.",
};

export type ConsoleEffect =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "chat"; text: string }
  | { kind: "desk"; command: DeskCommand; n?: number }
  | { kind: "read"; what: "whoami" | "swaps" }
  | { kind: "settings"; patch: Record<string, unknown> }
  /** Client-side: the wallet does these. The route only echoes them back. */
  | { kind: "wallet"; action: "connect" | "balance" }
  | { kind: "wallet"; action: "quote" | "swap"; amount: number; from: string; to: string }
  /** Client-side: the page opens one of the site's own pages beside the console, or closes it (null). */
  | { kind: "view"; view: ConsoleView | null };

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
}

const ok = (lines: string[], effect: ConsoleEffect = { kind: "none" }, suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect, suggest } : { lines, effect });
const err = (lines: string[], suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect: { kind: "none" }, error: true, suggest } : { lines, effect: { kind: "none" }, error: true });

const DESK: DeskCommand[] = ["status", "positions", "thoughts", "research", "watch", "reads"];
const DESK_ALIAS: Record<string, DeskCommand> = { book: "positions", thought: "thoughts", log: "research", live: "watch", read: "reads" };

export const HELP = [
  "Type a message to talk to your agent, or start a line with / for a command.",
  "",
  "  /explore           A short tour, one step at a time",
  "  /status            What the desk is doing right now",
  "  /trade /rewards /cards /referral /yield   Open a page of the app beside the console",
  "  /swap 0.05 ETH USDG   Swap from your own wallet through the pools",
  "  /connect           Sign in with your wallet and meet your own agent",
  "",
  "  /help all          Every command",
];

export const HELP_ALL = [
  "Every command. Anything without a slash is a message to your agent.",
  "",
  "  Your agent",
  "    /whoami            How it's set up right now",
  "    /name <name>       Give it a name",
  "    /style <style>     concise, balanced or deep",
  "    /voice <text>      How it should sound: dry, warm, blunt, your call",
  "    /goal <text>       What you want it working toward",
  "    /reset <field>     Put one setting back to the default",
  "",
  "  The app (opens beside the console; /close puts it away)",
  "    /trade             Swap through Obscura's routes",
  "    /rewards           Your cashback in tokenized stocks",
  "    /cards             The Obscura card",
  "    /referral          The referral waitlist",
  "    /yield             Coming soon, with its waitlist",
  "",
  "  The desk (live, read only)",
  "    /status /positions /thoughts [n] /research [n] /watch /reads",
  "",
  "  Your wallet",
  "    /connect           Sign in with your wallet, on Robinhood Chain",
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

/** The tour: what this is, whether to take its word, how to check, then the parts that need a wallet. */
export const TOUR: Array<{ title: string; lines: string[]; tryIt: string }> = [
  { title: "This is a live desk", lines: ["Agent OBS trades from its own wallet on Robinhood Chain and thinks out loud.", "Every cycle it records what it read, what it made of it, and what it decided."], tryIt: "/status" },
  { title: "Read it, don't take its word", lines: ["Every number on the page comes from a read the desk made. The thoughts are its own words;", "the research log is what it read between cycles."], tryIt: "/thoughts 2" },
  { title: "Quote through the pools", lines: ["The desk quotes the pools directly, where every swap on this chain settles, and shows", "the app's Relay route beside it, so you can see the spread for yourself."], tryIt: "/quote 0.05 ETH USDG" },
  { title: "Swap from your own wallet", lines: ["Your wallet signs, the swap pays your address in the same transaction, and the desk", "reads it off the chain. Nothing is ever held for you."], tryIt: "/swap 0.05 ETH USDG" },
  { title: "An agent of your own", lines: ["Sign in with your wallet and you get your own agent. It reads the desk, remembers your", "conversation, and you can name it and shape how it talks."], tryIt: "/connect" },
];

const list = (xs: readonly string[]) => xs.join(" | ");

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
      if (arg.toLowerCase() === "all") return ok(HELP_ALL);
      return ok(HELP, { kind: "none" }, ["/explore", "/status", ctx.signedIn ? "/whoami" : "/connect"]);
    case "clear":
      return ok([], { kind: "clear" });
    case "explore":
    case "tour": {
      const step = Math.max(1, Math.min(TOUR.length, parseInt(arg, 10) || 1));
      const t = TOUR[step - 1];
      const last = step >= TOUR.length;
      return ok([`(${step}/${TOUR.length}) ${t.title}`, ``, ...t.lines, ...(last ? [``, `That's the tour. /help has the full list whenever you want it.`] : [])], { kind: "none" }, last ? [t.tryIt] : [t.tryIt, `/explore ${step + 1}`]);
    }
    case "whoami":
    case "settings":
      return ok([], { kind: "read", what: "whoami" });
    case "swaps":
    case "eligible":
    case "progress":
      return ok([], { kind: "read", what: "swaps" });
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
      if (!arg) return err(["Tell it what you're working toward: /goal <a sentence>", `Right now: ${s.goal ?? "not set"}`]);
      return ok([], { kind: "settings", patch: { goal: arg } });
    case "reset": {
      const f = arg.toLowerCase();
      const fields: Record<string, Record<string, unknown>> = { name: { name: "" }, goal: { goal: "" }, voice: { voice: "" }, style: { style: "balanced" } };
      if (!f || !(f in fields)) return err([`Put a setting back to the default: /reset ${Object.keys(fields).join(", /reset ")}`]);
      return ok([], { kind: "settings", patch: fields[f] });
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

export const VOCAB = ["help", "explore", "clear", "whoami", "name", "style", "voice", "goal", "reset", "swaps", "connect", "balance", "quote", "swap", ...VIEWS, "close", ...DESK];

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
