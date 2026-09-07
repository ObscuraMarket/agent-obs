// The obs command line's grammar, pure, shared with its tests and mirrored by the web console at /console. One
// command in, one typed command out; the runner in src/cli.ts does the work.
export type CliCommand =
  | { kind: "help" }
  | { kind: "status" | "positions" | "watch" | "reads" }
  | { kind: "thoughts" | "research"; n: number }
  | { kind: "quote" | "swap"; amount: number; from: string; to: string }
  | { kind: "eligible"; address: string | null }
  | { kind: "wallet"; args: string[] }
  | { kind: "capital"; args: string[] }
  | { kind: "model"; args: string[] }
  | { kind: "verify"; args: string[] }
  | { kind: "run"; what: "desk" | "paper" | "live" | "dashboard" | "" }
  | { kind: "unknown"; text: string };

/** PURE: argv after the program name, as a command. "obs swap 0.05 ETH USDG", "obs thoughts 5", "obs run live". */
export function parseCli(argv: string[]): CliCommand {
  const [head = "", ...rest] = argv.map((a) => String(a ?? "").trim()).filter(Boolean);
  const w = head.toLowerCase();
  const n = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
  switch (w) {
    case "":
    case "help":
    case "-h":
    case "--help":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "positions":
    case "book":
      return { kind: "positions" };
    case "watch":
    case "live":
      return { kind: "watch" };
    case "reads":
    case "read":
      return { kind: "reads" };
    case "thoughts":
    case "thought":
      return { kind: "thoughts", n: n ?? 3 };
    case "research":
    case "log":
      return { kind: "research", n: n ?? 12 };
    case "swaps":
    case "eligible":
    case "progress":
      return { kind: "eligible", address: rest[0] && /^0x[0-9a-fA-F]{40}$/.test(rest[0]) ? rest[0] : null };
    case "quote":
    case "swap": {
      const m = rest.join(" ").match(/^([\d,]*\d(?:\.\d+)?)\s+([A-Za-z0-9]+)\s*(?:->|to|for)?\s+([A-Za-z0-9]+)$/i);
      const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
      if (m && amount > 0) return { kind: w, amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() };
      return { kind: "unknown", text: [head, ...rest].join(" ") };
    }
    case "wallet":
      return { kind: "wallet", args: rest };
    case "capital":
      return { kind: "capital", args: rest };
    case "model":
      return { kind: "model", args: rest };
    case "verify":
      return { kind: "verify", args: rest };
    case "run": {
      const what = (rest[0] ?? "").toLowerCase();
      return { kind: "run", what: what === "desk" || what === "paper" || what === "live" || what === "dashboard" ? what : "" };
    }
    default:
      return { kind: "unknown", text: [head, ...rest].join(" ") };
  }
}

export const HELP: Array<[string, string]> = [
  ["obs status", "the desk: equity, PnL, what it holds"],
  ["obs positions", "open positions and the last day's closed trades"],
  ["obs thoughts [n]", "the desk's last decisions, in its own words"],
  ["obs research [n]", "what it read between cycles: launches, tapes, holders"],
  ["obs watch", "the live watch: every pool in play right now"],
  ["obs reads", "the chain as the desk reads it: prices, the OBS market"],
  ["obs quote 0.05 ETH USDG", "what the pools pay, with the app's Relay route beside it"],
  ["obs swap 0.05 ETH USDG", "the same, signed by your own wallet, paid to your address, counted by the desk"],
  ["obs swaps [0x...]", "the swaps a wallet made through the console"],
  ["obs wallet create | address | balances", "your own wallet, a file on this machine"],
  ["obs capital deposit ETH 0.1 | list", "the capital ledger of your own agent"],
  ["obs model check", "does your model answer"],
  ["obs verify swaps", "the routing backend, Relay and the pools against each other"],
  ["obs run desk | paper | live | dashboard", "your own agent: one cycle, a paper cycle, the live watch, the page"],
];
