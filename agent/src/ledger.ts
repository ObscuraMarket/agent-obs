// Durable JSONL rows, one way to write them. Local files only for now; a
// database mirror can sit behind the same signature later.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dataPath } from "./config.ts";

let failures = 0;

/**
 * Append one row. Never throws: a ledger write must never fail the job. It says whether the row landed, and a row
 * that did not is counted, because a caller with money in motion has to know (the pool lane, 2026-09-08: a trade
 * row that was never written is a token in the wallet the book cannot see).
 */
export function appendLedger(file: string, row: Record<string, unknown>): boolean {
  try {
    appendFileSync(dataPath(file), JSON.stringify(row) + "\n");
    return true;
  } catch (e) {
    failures += 1;
    console.error(`[ledger] ${file} did not take a row: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** How many appends have failed since this process started, over every ledger. */
export function ledgerWriteFailures(): number {
  return failures;
}

export function readLedger<T = Record<string, unknown>>(file: string): T[] {
  const p = dataPath(file);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a bad line rather than lose the ledger */
    }
  }
  return out;
}
