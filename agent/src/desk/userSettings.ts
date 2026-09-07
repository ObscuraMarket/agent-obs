// What a person can set on their own agent: a name, a style, a voice, a goal. Prompt-level, because the agent is
// a conversation; a setting exists only if it changes how the agent talks or what it keeps in mind. Enums are
// checked against fixed sets; free text is cleaned and capped, because every value here is interpolated into the
// agent's instruction and a paragraph is an instruction in disguise. Stored append-only, latest row per wallet.
import { appendLedger, readLedger } from "../ledger.ts";

const FILE = "obs-agent-settings.jsonl";
const MAX_NAME = 32;
const MAX_GOAL = 280;
const MAX_VOICE = 200;

export const STYLES = ["concise", "balanced", "deep"] as const;
export type Style = (typeof STYLES)[number];

export interface UserSettings {
  name?: string;
  style?: Style;
  voice?: string;
  goal?: string;
  /** An OpenRouter model id the agent runs on; unset means the default. Checked against the catalog by the route. */
  model?: string;
}

interface Row extends UserSettings {
  address: string;
  at: number;
}

function cleanText(raw: unknown, cap: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, cap);
  return cleaned.length ? cleaned : null;
}

/** PURE: a name, stricter than the other text: it is what the agent answers to and it lands inside a prompt. */
export function sanitizeName(raw: unknown): string | null {
  const cleaned = cleanText(raw, MAX_NAME);
  if (cleaned === null) return null;
  const stripped = cleaned.replace(/[<>{}[\]\\`|]/g, "").replace(/\s+/g, " ").trim();
  return stripped.length ? stripped : null;
}

/**
 * PURE: a partial patch from an untrusted request as the cleaned fields it carries, or an error. A field that is
 * present and invalid is refused rather than dropped, so the person is told. An empty string clears a field.
 */
export function sanitizeSettings(patch: unknown): { settings: UserSettings } | { error: string } {
  const p = (patch ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return { error: "settings must be an object" };
  const out: UserSettings = {};
  if ("name" in p) {
    if (p.name === "" || p.name === null) out.name = "";
    else {
      const n = sanitizeName(p.name);
      if (!n) return { error: `a name is up to ${MAX_NAME} plain characters` };
      out.name = n;
    }
  }
  if ("style" in p) {
    const s = typeof p.style === "string" ? p.style.toLowerCase() : "";
    if (!STYLES.includes(s as Style)) return { error: `style is one of ${STYLES.join(", ")}` };
    out.style = s as Style;
  }
  if ("voice" in p) {
    if (p.voice === "" || p.voice === null) out.voice = "";
    else {
      const v = cleanText(p.voice, MAX_VOICE);
      if (!v) return { error: `a voice is up to ${MAX_VOICE} plain characters` };
      out.voice = v;
    }
  }
  if ("goal" in p) {
    if (p.goal === "" || p.goal === null) out.goal = "";
    else {
      const g = cleanText(p.goal, MAX_GOAL);
      if (!g) return { error: `a goal is up to ${MAX_GOAL} plain characters` };
      out.goal = g;
    }
  }
  if ("model" in p) {
    if (p.model === "" || p.model === null) out.model = "";
    else {
      const m = typeof p.model === "string" ? p.model.trim() : "";
      if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(m) || m.length > 80) return { error: "a model is an OpenRouter id like anthropic/claude-opus-5" };
      out.model = m;
    }
  }
  if (!Object.keys(out).length) return { error: "nothing to set: name, style, voice, goal or model" };
  return { settings: out };
}

/** The latest settings row per wallet, merged. */
export function getSettings(address: string, rows: Row[] = readLedger<Row>(FILE)): UserSettings {
  const addr = address.toLowerCase();
  let s: UserSettings = {};
  for (const r of rows) {
    if (!r || r.address !== addr) continue;
    const { address: _a, at: _t, ...rest } = r;
    s = { ...s, ...rest };
  }
  for (const k of ["name", "voice", "goal", "model"] as const) if (s[k] === "") delete s[k];
  return s;
}

/** Merge a cleaned patch into the wallet's settings and record it. */
export function updateSettings(address: string, patch: UserSettings): UserSettings {
  appendLedger(FILE, { address: address.toLowerCase(), at: Date.now(), ...patch });
  return getSettings(address);
}

export const DEFAULT_NAME = "OBS";

/** PURE: the settings as lines, for /whoami and after a change. */
export function describeSettings(s: UserSettings): string[] {
  return [
    `name    ${s.name ?? `${DEFAULT_NAME} (default)`}`,
    `style   ${s.style ?? "balanced (default)"}`,
    `voice   ${s.voice ?? "not set"}`,
    `goal    ${s.goal ?? "not set"}`,
    `model   ${s.model ?? "the default"}`,
  ];
}
