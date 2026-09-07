// The desk's model, chosen from the environment: one prompt in, one reply out. Three ways to think, in this order:
// the OpenHermit gateway (the operator's setup, where the personas were provisioned), an Anthropic key, or any
// endpoint that speaks the OpenAI chat shape (OpenRouter, a local server). The persona files ship with the repo,
// so the two direct paths read the same identity, rules, soul and knowledge the gateway holds; the desk prompt
// itself carries every rule of the trade. The X jobs still speak only through the gateway's copywriter persona.
// Nothing here is silent: a model that cannot answer returns the reason, and the cycle prints it in red.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayClient } from "@openhermit/sdk";
import { AGENT_ID, ROOT_DIR, dataPath } from "../config.ts";

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

/**
 * A persona on the gateway, ready to think. Each think opens its own session: the prompt already carries the desk's
 * memory (its last thoughts and its journal), so a shared session that kept every past prompt in the model's
 * context only made every think longer and dearer. OBS_GATEWAY_SESSION=shared keeps the old one session.
 */
function gatewayModel(gw: GatewayClient, agentId: string, name: string, env: Env = process.env): Model {
  return {
    kind: "gateway",
    name,
    async think(prompt) {
      const sessionId = (env.OBS_GATEWAY_SESSION ?? "fresh") === "shared" ? "desk-cycle" : `desk-${Date.now()}`;
      await gw.agent(agentId).openSession({ sessionId, source: { kind: "api", interactive: true, type: "direct" } }).catch(() => {});
      try {
        const r = await gw.agent(agentId).postMessageSync(sessionId, { text: prompt }, { timeout: TIMEOUT_MS });
        return { text: r.text ?? null, ...(r.error ? { error: r.error } : {}) };
      } catch (e) {
        return { text: null, error: reasonOf(e) };
      }
    },
  };
}

/**
 * PURE: the persona a fast tick thinks through, on a cheaper model, or null when the operator switched it off. The
 * default is a model that writes without reasoning first: on a desk-sized prompt a reasoning model (DeepSeek V4 flash,
 * 2026-09-07) spent its whole budget thinking, wrote nothing, and overran the gateway's 90 s on four ticks in six.
 */
export function tickChoice(env: Env = process.env): { agentId: string; model: string } | null {
  const model = (env.OBS_TICK_MODEL ?? "google/gemini-2.5-flash").trim();
  if (!model || model.toLowerCase() === "off") return null;
  return { agentId: env.OBS_TICK_AGENT_ID || `${AGENT_ID}-fast`, model };
}

const TICK_MARKER = "obs-tick-persona.json";

/**
 * The fast persona on the gateway: the same identity, rules, soul and knowledge as the desk's, on the cheaper model,
 * created if missing and refreshed when a file or the model changed (a marker in the data dir says what was last
 * written, since every tick is its own process).
 */
export async function ensureTickPersona(gw: GatewayClient, choice: { agentId: string; model: string }, root = ROOT_DIR, env: Env = process.env): Promise<void> {
  const files: Array<[string, string]> = [];
  for (const key of ["identity", "rules", "soul", "knowledge"]) {
    const f = join(root, "personality", "obs", `${key}.md`);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8").replace(/^#\s+\w+\s*\n/, "").trim();
    if (text && !text.includes("\u2014")) files.push([key, text]);
  }
  const stamp = JSON.stringify({ agentId: choice.agentId, model: choice.model, sizes: files.map(([k, t]) => [k, t.length]) });
  const marker = dataPath(TICK_MARKER);
  try { if (existsSync(marker) && readFileSync(marker, "utf8") === stamp) return; } catch { /* rewrite below */ }
  const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
  if (!existing.has(choice.agentId)) await gw.createAgent({ agentId: choice.agentId, name: "OBS (fast tick)", sandbox: null, ownerUserId: env.OBS_OWNER_USER_ID || undefined });
  const current = (await gw.getAgentConfig(choice.agentId)) as Record<string, unknown>;
  const curModel = (current.model ?? {}) as Record<string, unknown>;
  await gw.putAgentConfig(choice.agentId, { ...current, workspace_root: typeof current.workspace_root === "string" ? current.workspace_root : `/agents/${choice.agentId}`, model: { ...curModel, provider: env.OBS_USER_MODEL_PROVIDER || "openrouter", model: choice.model, max_tokens: MAX_TOKENS } });
  for (const [key, text] of files) await gw.setInstruction(choice.agentId, key, text);
  writeFileSync(marker, stamp);
}

/** The model a fast entry tick thinks through, when the gateway is the desk's model and a tick model is set; else null and the tick keeps the main persona. */
export async function tickModelFromEnv(env: Env = process.env): Promise<Model | null> {
  const c = modelChoice(env);
  const t = tickChoice(env);
  if (!c || c.kind !== "gateway" || !t) return null;
  const gw = new GatewayClient({ baseUrl: c.baseUrl, token: c.token });
  try {
    await ensureTickPersona(gw, t, ROOT_DIR, env);
  } catch (e) {
    console.error(`[desk] the fast persona is not ready (${reasonOf(e)}); thinking through ${AGENT_ID}`);
    return null;
  }
  return gatewayModel(gw, t.agentId, `the gateway, persona ${t.agentId} on ${t.model}`, env);
}

/** The model the environment names, ready to think, or null with the reason in noModelWhy(). */
export function modelFromEnv(env: Env = process.env, fetchFn: Fetch = fetch, persona: () => string = () => personaText()): Model | null {
  const c = modelChoice(env);
  if (!c) return null;
  if (c.kind === "gateway") return gatewayModel(new GatewayClient({ baseUrl: c.baseUrl, token: c.token }), AGENT_ID, `the gateway, persona ${AGENT_ID}`, env);
  const system = persona();
  return { kind: c.kind, name: `${c.kind === "anthropic" ? "Anthropic" : c.url} ${c.model}`, think: (prompt) => direct(c, system, prompt, fetchFn) };
}
