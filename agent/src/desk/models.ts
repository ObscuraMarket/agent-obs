// The models a person can pick for their own agent: every model OpenRouter serves, with what it costs. The catalog
// is read from OpenRouter (public, no key) and cached for an hour; the last good read stands in when it is down.
// Prices are OpenRouter's, per token, in dollars; the desk charges them per turn plus its margin (credits.ts).
// The gateway itself has no usage counter in its stream, so a turn's tokens are estimated from the text that went
// in and came out (about four characters a token), and the margin covers the estimate.

export interface ModelInfo {
  id: string;
  name: string;
  /** Dollars per million tokens, in and out. */
  promptPerM: number;
  completionPerM: number;
  context: number;
  free: boolean;
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000;
// A model that answers at once: Gemini 2.5 flash finishes a console turn in about a second, where a model that
// reasons before it writes (DeepSeek V4 flash, 2026-09-07) took three to seven. A turn costs under half a credit.
export const DEFAULT_MODEL = process.env.OBS_USER_MODEL_ID || "google/gemini-2.5-flash";
const FEATURED = (process.env.OBS_MODELS_FEATURED || "anthropic/claude-opus-5,openai/gpt-6-astra,google/gemini-3.8-flash,deepseek/deepseek-v4-flash-0731,x-ai/grok-4.6,meta-llama/llama-4-maverick").split(",").map((s) => s.trim()).filter(Boolean);

let cache: { at: number; models: ModelInfo[] } | null = null;

/** PURE: OpenRouter's rows as the catalog: id, name, prices per million, context, free or not. Rows that cannot be priced are dropped. */
export function parseCatalog(rows: unknown[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const r of rows) {
    const x = r as { id?: unknown; name?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
    if (typeof x.id !== "string" || !x.id) continue;
    const p = Number(x.pricing?.prompt);
    const c = Number(x.pricing?.completion);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) continue;
    out.push({ id: x.id, name: typeof x.name === "string" ? x.name : x.id, promptPerM: p * 1e6, completionPerM: c * 1e6, context: Number(x.context_length) || 0, free: p === 0 && c === 0 });
  }
  return out;
}

/** The catalog, fresh within the hour. Never throws: an unreachable catalog yields the last one, or nothing. */
export async function catalog(now = Date.now()): Promise<ModelInfo[]> {
  if (cache && now - cache.at < CATALOG_TTL_MS) return cache.models;
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(8_000) });
    const j = (await res.json()) as { data?: unknown[] };
    const models = parseCatalog(Array.isArray(j.data) ? j.data : []);
    if (models.length) cache = { at: now, models };
  } catch (e) {
    console.error(`[models] catalog not read: ${e instanceof Error ? e.message : String(e)}`);
  }
  return cache?.models ?? [];
}

export async function modelInfo(id: string): Promise<ModelInfo | null> {
  return (await catalog()).find((m) => m.id === id) ?? null;
}

/**
 * The default model's price as known, for a turn the catalog cannot price at all (the catalog cold at boot, or
 * OpenRouter down): a turn is metered at this rather than at nothing (2026-09-08). Gemini 2.5 Flash's list price.
 */
export const DEFAULT_MODEL_INFO: ModelInfo = { id: DEFAULT_MODEL, name: DEFAULT_MODEL, promptPerM: 0.3, completionPerM: 2.5, context: 1_048_576, free: false };

/** PURE: the models a search names, best first: an exact id, then ids and names containing every word. */
export function findModels(models: ModelInfo[], query: string, limit = 8): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = models.find((m) => m.id.toLowerCase() === q);
  if (exact) return [exact];
  const words = q.split(/\s+/).filter(Boolean);
  const hit = models.filter((m) => { const hay = `${m.id} ${m.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  hit.sort((a, b) => Number(a.id.includes(":")) - Number(b.id.includes(":")) || a.id.localeCompare(b.id));
  return hit.slice(0, limit);
}

/** PURE: the featured list, in the operator's order, only the ones the catalog has. */
export function featured(models: ModelInfo[], ids: string[] = FEATURED): ModelInfo[] {
  return ids.map((id) => models.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m);
}

/** PURE: about four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

/** PURE: what a turn costs in dollars at the model's prices, with the desk's margin on top. */
export function turnCostUsd(m: ModelInfo, tokensIn: number, tokensOut: number, marginPct: number): number {
  if (m.free) return 0;
  const raw = (tokensIn * m.promptPerM + tokensOut * m.completionPerM) / 1e6;
  return Math.round(raw * (1 + marginPct / 100) * 1e6) / 1e6;
}

const money = (v: number): string => (v === 0 ? "free" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** PURE: one model as a line a person can read: id, then what a million tokens cost in and out. */
export function modelLine(m: ModelInfo, current = false): string {
  const price = m.free ? "free" : `${money(m.promptPerM)} in, ${money(m.completionPerM)} out per million tokens`;
  return `${current ? "> " : "  "}${m.id}  ${price}`;
}
