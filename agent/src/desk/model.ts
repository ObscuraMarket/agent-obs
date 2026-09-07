// The desk's model, chosen from the environment: one prompt in, one reply out. Three ways to think, in this order:
// the OpenHermit gateway (the operator's setup, where the personas were provisioned), an Anthropic key, or any
// endpoint that speaks the OpenAI chat shape (OpenRouter, a local server). The persona files ship with the repo,
// so the two direct paths read the same identity, rules, soul and knowledge the gateway holds; the desk prompt
// itself carries every rule of the trade. The X jobs still speak only through the gateway's copywriter persona.
// Nothing here is silent: a model that cannot answer returns the reason, and the cycle prints it in red.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient } from "@openhermit/sdk";
import { AGENT_ID, ROOT_DIR } from "../config.ts";

export interface Reply {
  text: string | null;
  error?: string;
}

export interface Model {
  kind: "gateway" | "anthropic" | "openai";
  /** What the desk says it thinks through, for the log. Never a key. */
  name: string;
  think(prompt: string): Promise<Reply>;
}

export type Choice =
  | { kind: "gateway"; baseUrl: string; token: string }
  | { kind: "anthropic"; key: string; model: string }
  | { kind: "openai"; url: string; key: string | null; model: string };

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
const TIMEOUT_MS = 90_000;
const MAX_TOKENS = 1500;

/** PURE: which model the environment names, the gateway first, or null when none is configured. */
export function modelChoice(env: Env = process.env): Choice | null {
  if (env.OPENHERMIT_GATEWAY_URL && env.GATEWAY_ADMIN_TOKEN) return { kind: "gateway", baseUrl: env.OPENHERMIT_GATEWAY_URL, token: env.GATEWAY_ADMIN_TOKEN };
  if (env.ANTHROPIC_API_KEY) return { kind: "anthropic", key: env.ANTHROPIC_API_KEY, model: env.OBS_MODEL || DEFAULT_ANTHROPIC_MODEL };
  if (env.OBS_MODEL_URL && env.OBS_MODEL) return { kind: "openai", url: env.OBS_MODEL_URL.replace(/\/+$/, ""), key: env.OBS_MODEL_KEY || null, model: env.OBS_MODEL };
  return null;
}

/** PURE: why there is no model, said so the operator knows which variable to set. */
export function noModelWhy(env: Env = process.env): string {
  if (env.OBS_MODEL_URL && !env.OBS_MODEL) return "OBS_MODEL_URL is set but OBS_MODEL does not name the model";
  return "set OPENHERMIT_GATEWAY_URL with GATEWAY_ADMIN_TOKEN, or ANTHROPIC_API_KEY, or OBS_MODEL_URL with OBS_MODEL";
}

/** The persona files as one system prompt: identity, rules, soul, knowledge, each without its heading. */
export function personaText(dir = "obs", root = ROOT_DIR): string {
  const parts: string[] = [];
  for (const key of ["identity", "rules", "soul", "knowledge"]) {
    const f = join(root, "personality", dir, `${key}.md`);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8").replace(/^#\s+\w+\s*\n/, "").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export interface Request {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** PURE: the Anthropic Messages request for one prompt under the persona. */
export function anthropicRequest(c: Extract<Choice, { kind: "anthropic" }>, system: string, prompt: string): Request {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": "2023-06-01" },
    body: { model: c.model, max_tokens: MAX_TOKENS, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] },
  };
}

/** PURE: the OpenAI-shape chat request for one prompt under the persona; the bearer only when there is a key. */
export function openaiRequest(c: Extract<Choice, { kind: "openai" }>, system: string, prompt: string): Request {
  return {
    url: `${c.url}/chat/completions`,
    headers: { "content-type": "application/json", ...(c.key ? { authorization: `Bearer ${c.key}` } : {}) },
    body: { model: c.model, max_tokens: MAX_TOKENS, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }] },
  };
}

/** PURE: the reply's text from either shape, or null when there is none. */
export function textOf(kind: "anthropic" | "openai", json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (kind === "anthropic") {
    const content = Array.isArray(j.content) ? j.content : [];
    const text = content.filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string").map((b) => b.text).join("\n").trim();
    return text || null;
  }
  const choices = Array.isArray(j.choices) ? j.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const text = typeof first?.message?.content === "string" ? first.message.content.trim() : "";
  return text || null;
}

/** PURE: the provider's reason for refusing, or the status when it gave none. */
export function errorOf(status: number, json: unknown): string {
  const e = json && typeof json === "object" ? (json as { error?: unknown }).error : null;
  const msg = e && typeof e === "object" ? (e as { message?: unknown }).message : typeof e === "string" ? e : null;
  return typeof msg === "string" && msg.trim() ? `HTTP ${status}: ${msg.trim().slice(0, 200)}` : `HTTP ${status}`;
}

/** PURE: a thrown failure as a reason the operator can act on: the cause behind Node's "fetch failed", or the timeout. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === "AbortError") return `no answer in ${TIMEOUT_MS / 1000} s`;
  const cause = (e as { cause?: unknown }).cause;
  const c = cause instanceof Error ? cause.message : cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : null;
  return c ? `${e.message} (${c})` : e.message;
}

async function direct(c: Exclude<Choice, { kind: "gateway" }>, system: string, prompt: string, fetchFn: Fetch): Promise<Reply> {
  const req = c.kind === "anthropic" ? anthropicRequest(c, system, prompt) : openaiRequest(c, system, prompt);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { text: null, error: errorOf(res.status, json) };
    const text = textOf(c.kind, json);
    return text == null ? { text: null, error: "the model returned no text" } : { text };
  } catch (e) {
    return { text: null, error: reasonOf(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** The model the environment names, ready to think, or null with the reason in noModelWhy(). */
export function modelFromEnv(env: Env = process.env, fetchFn: Fetch = fetch, persona: () => string = () => personaText()): Model | null {
  const c = modelChoice(env);
  if (!c) return null;
  if (c.kind === "gateway") {
    const gw = new GatewayClient({ baseUrl: c.baseUrl, token: c.token });
    return {
      kind: "gateway",
      name: `the gateway, persona ${AGENT_ID}`,
      async think(prompt) {
        const sessionId = "desk-cycle";
        await gw.agent(AGENT_ID).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
        try {
          const r = await gw.agent(AGENT_ID).postMessageSync(sessionId, { text: prompt }, { timeout: TIMEOUT_MS });
          return { text: r.text ?? null, ...(r.error ? { error: r.error } : {}) };
        } catch (e) {
          return { text: null, error: reasonOf(e) };
        }
      },
    };
  }
  const system = persona();
  return { kind: c.kind, name: `${c.kind === "anthropic" ? "Anthropic" : c.url} ${c.model}`, think: (prompt) => direct(c, system, prompt, fetchFn) };
}
