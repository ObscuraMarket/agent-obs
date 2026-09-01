// Paths and environment for OBS. Loads ./.env if present (never overriding a
// value already in the environment), then strips anything key-shaped: OBS
// holds no signer, whatever file it was started from.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.search(/\s#/);
    if (hash > 0 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();
for (const k of Object.keys(process.env)) if (/PRIVATE_KEY|SIGNER_KEY|MNEMONIC|SEED_PHRASE/i.test(k)) delete process.env[k];

export const ROOT_DIR = ROOT;
export const DATA_DIR = process.env.OBS_DATA_DIR || join(ROOT, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
export const dataPath = (file: string): string => join(DATA_DIR, file);

export const AGENT_ID = process.env.OBS_AGENT_ID || "obs";
export const X_AGENT_ID = process.env.OBS_X_AGENT_ID || "obs-copywriter";
export const X_HANDLE = (process.env.X_HANDLE || "ObscuraCEX").replace(/^@/, "");
export const DRY = process.env.DRY_RUN === "1";
export const MIN_POST_GAP_MIN = Number(process.env.OBS_MIN_POST_GAP_MIN ?? 90);
export const ENGAGE_CAP = Number(process.env.OBS_ENGAGE_CAP ?? 3);
export const SIMILARITY_MAX = Number(process.env.OBS_SIMILARITY_MAX ?? 0.45);
export const MAX_TWEET_CHARS = Number(process.env.X_MAX_TWEET_CHARS ?? 280);

export const RPC_URL = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
/** The one 40-hex address a post may contain. Anything else is blocked. */
export const OBS_CONTRACT = (process.env.OBS_CONTRACT || "0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e").toLowerCase();
export const SITE_URL = (process.env.OBSCURA_SITE_URL || "https://obscura.market").replace(/\/+$/, "");
export const API_URL = (process.env.OBSCURA_API_URL || "https://api.obscura.market").replace(/\/+$/, "");
