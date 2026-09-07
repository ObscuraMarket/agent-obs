// The console's router: one typed line in, a plain object out. Pure: nothing here reads the network, the clock or
// a request. The route applies the effect with the wallet session; this module only decides, and it can be tested
// by calling it. That split matters because a command surface is user text deciding which capability runs.
//
// A line without a leading slash is something to say to your agent. A line with one is a command: shaping your
// agent, reading the desk, or using your wallet. Every settings change is an intent the route applies through the
// same validator the settings route uses, never a write from here.
import { STYLES, DEFAULT_NAME, type UserSettings } from "../desk/userSettings.ts";

export type DeskCommand = "status" | "positions" | "thoughts" | "research" | "watch" | "reads";

export type ConsoleEffect =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "chat"; text: string }
  | { kind: "desk"; command: DeskCommand; n?: number }
  | { kind: "read"; what: "whoami" | "eligible" }
  | { kind: "settings"; patch: Record<string, unknown> }
  /** Client-side: the wallet does these. The route only echoes them back. */
  | { kind: "wallet"; action: "connect" | "balance" }
  | { kind: "wallet"; action: "quote" | "swap"; amount: number; from: string; to: string };

export interface ConsoleResult {
  lines: string[];
  effect: ConsoleEffect;
  error?: boolean;
  /** One-tap next steps: literal lines to submit, a command or a message. */
  suggest?: string[];
}

export interface ConsoleContext {
  settings: UserSettings;
  eligible: boolean;
  swaps: number;
  required: number;
}

const ok = (lines: string[], effect: ConsoleEffect = { kind: "none" }, suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect, suggest } : { lines, effect });
const err = (lines: string[], suggest?: string[]): ConsoleResult => (suggest?.length ? { lines, effect: { kind: "none" }, error: true, suggest } : { lines, effect: { kind: "none" }, error: true });

const DESK: DeskCommand[] = ["status", "positions", "thoughts", "research", "watch", "reads"];
const DESK_ALIAS: Record<string, DeskCommand> = { book: "positions", thought: "thoughts", log: "research", live: "watch", read: "reads" };

export const HELP = [
  "type a message to talk to your agent. commands start with a slash.",
  "",
  "  /explore           a short guided tour, one thing at a time",
  "  /status            what the desk is doing right now",
  "  /swap 0.05 ETH USDG   a swap from your own wallet, through the pools",
  "  /eligible          your swaps against the bar that unlocks your agent",
  "",
  "  /help all          every command",
];

export const HELP_ALL = [
  "every command. anything without a slash is a message to your agent.",
  "",
  "  your agent",
  "    /whoami            how it is set right now",
  "    /name <name>       rename it",
  "    /style <style>     concise | balanced | deep",
  "    /voice <text>      how it should sound: dry, warm, blunt, your call",
  "    /goal <text>       what you want it working toward",
  "    /reset <field>     clear one setting back to default",
  "",
  "  the desk (live, read only)",
  "    /status /positions /thoughts [n] /research [n] /watch /reads",
  "",
  "  your wallet",
  "    /connect           your wallet, on Robinhood Chain",
  "    /balance           ETH in it",
  "    /quote 0.05 ETH USDG   what the pools pay, the app's Relay route beside it",
  "    /swap 0.05 ETH USDG    the same, signed by your wallet, paid to your address",
  "    /eligible          verified swaps against the bar",
  "",
  "  session",
  "    /explore /clear /help",
  "",
  "  talking to your agent is free. so is every command.",
];

/** The tour: what this is, is it telling the truth, can you check it, then the parts that need a wallet. */
export const TOUR: Array<{ title: string; lines: string[]; tryIt: string }> = [
  { title: "this is a live desk", lines: ["Agent OBS trades from its own wallet on Robinhood Chain and reasons in public.", "every cycle it records what it read, what it thought and what it decided."], tryIt: "/status" },
  { title: "read it rather than trust it", lines: ["every figure on the page traces to a read the desk made. the thoughts are its own words;", "the research log is what it read between cycles."], tryIt: "/thoughts 2" },
  { title: "quote through the pools", lines: ["the desk's router quotes the pools directly, where every swap on this chain settles.", "the app's Relay route is shown beside it, so you can see the spread."], tryIt: "/quote 0.05 ETH USDG" },
  { title: "swap from your own wallet", lines: ["your wallet signs, the swap pays your address in the same transaction, and the desk", "reads it off the chain. three verified swaps make your wallet eligible for its own agent."], tryIt: "/swap 0.05 ETH USDG" },
  { title: "your agent is yours", lines: ["once eligible, an agent is provisioned to your wallet with its own memory. it reads the", "desk, remembers this conversation, and you can shape how it works."], tryIt: "/whoami" },
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
      return err(["type /help to see what you can do."], ["/help"]);
    case "help":
    case "?":
      if (arg.toLowerCase() === "all") return ok(HELP_ALL);
      return ok(HELP, { kind: "none" }, ["/explore", "/status", ctx.eligible ? "/whoami" : "/eligible"]);
    case "clear":
      return ok([], { kind: "clear" });
    case "explore":
    case "tour": {
      const step = Math.max(1, Math.min(TOUR.length, parseInt(arg, 10) || 1));
      const t = TOUR[step - 1];
      const last = step >= TOUR.length;
      return ok([`(${step}/${TOUR.length}) ${t.title}`, ``, ...t.lines, ...(last ? [``, `that is the tour. /help has the full list whenever you want it.`] : [])], { kind: "none" }, last ? [t.tryIt] : [t.tryIt, `/explore ${step + 1}`]);
    }
    case "whoami":
    case "settings":
      return ok([], { kind: "read", what: "whoami" });
    case "eligible":
    case "progress":
      return ok([], { kind: "read", what: "eligible" });
    case "connect":
    case "balance":
      return ok([], { kind: "wallet", action: cmd });
    case "quote":
    case "swap": {
      const m = arg.match(/^([\d,]*\d(?:\.\d+)?)\s+([A-Za-z0-9]+)\s*(?:->|to|for)?\s+([A-Za-z0-9]+)$/i);
      const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
      if (!m || !(amount > 0)) return err([`usage: /${cmd} <amount> <FROM> <TO>`, `  eg  /${cmd} 0.05 ETH USDG`], [`/${cmd} 0.05 ETH USDG`]);
      return ok([], { kind: "wallet", action: cmd, amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() });
    }
    case "name":
      if (!arg) return err(["usage: /name <name>", `currently: ${s.name ?? `${DEFAULT_NAME} (default)`}`]);
      return ok([], { kind: "settings", patch: { name: arg } });
    case "style": {
      const v = arg.toLowerCase();
      if (!v) return err([`usage: /style <${list(STYLES)}>`, `currently: ${s.style ?? "balanced (default)"}`]);
      if (!STYLES.includes(v as never)) return err([`"${arg}" is not a style. pick one of: ${list(STYLES)}`], STYLES.map((x) => `/style ${x}`));
      return ok([], { kind: "settings", patch: { style: v } });
    }
    case "voice":
      if (!arg) return err(["usage: /voice <how it should sound>", `currently: ${s.voice ?? "not set"}`, `  eg  /voice dry and skeptical, never enthusiastic`]);
      return ok([], { kind: "settings", patch: { voice: arg } });
    case "goal":
      if (!arg) return err(["usage: /goal <what you want it working toward>", `currently: ${s.goal ?? "not set"}`]);
      return ok([], { kind: "settings", patch: { goal: arg } });
    case "reset": {
      const f = arg.toLowerCase();
      const fields: Record<string, Record<string, unknown>> = { name: { name: "" }, goal: { goal: "" }, voice: { voice: "" }, style: { style: "balanced" } };
      if (!f || !(f in fields)) return err([`usage: /reset <${Object.keys(fields).join(" | ")}>`]);
      return ok([], { kind: "settings", patch: fields[f] });
    }
    default: {
      const desk = DESK.includes(cmd as DeskCommand) ? (cmd as DeskCommand) : DESK_ALIAS[cmd];
      if (desk) {
        const n = /^\d+$/.test(arg) ? Number(arg) : undefined;
        return ok([], { kind: "desk", command: desk, ...(n != null ? { n } : {}) });
      }
      const near = suggest(cmd);
      return err(near.length ? [`"/${cmd}" is not a command. did you mean ${near[0]}?`] : [`"/${cmd}" is not a command. /help lists them.`], near.length ? near : ["/help"]);
    }
  }
}

export const VOCAB = ["help", "explore", "clear", "whoami", "name", "style", "voice", "goal", "reset", "eligible", "connect", "balance", "quote", "swap", ...DESK];

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
