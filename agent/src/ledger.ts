// Durable JSONL rows, one way to write them. Local files only for now; a
// database mirror can sit behind the same signature later.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dataPath } from "./config.ts";

export function appendLedger(file: string, row: Record<string, unknown>): void {
  try {
    appendFileSync(dataPath(file), JSON.stringify(row) + "\n");
  } catch {
    /* a ledger write must never fail the job */
  }
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
