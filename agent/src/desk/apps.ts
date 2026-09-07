// Your agent, connected to your apps. Through Composio, a wallet's agent can reach the apps that wallet's owner
// connects (Slack, Linear, X, Gmail, Google Docs and more): one Composio session per wallet, its MCP endpoint
// registered on the gateway and enabled for that wallet's agent only, and a policy that any action inside an app
// waits for the person's approval in the console. Composio holds the OAuth tokens; nothing of theirs is stored here.
// The desk's Composio key never reaches the browser: it rides in the MCP endpoint's headers on the gateway.
import { Composio } from "@composio/core";
import { agentIdForWallet, gateway } from "./userAgents.ts";

/** The apps a person can connect, by Composio toolkit slug, with the name they know them by. */
export const APP_NAMES: Record<string, string> = {
  slack: "Slack",
  linear: "Linear",
  twitter: "X",
  gmail: "Gmail",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googlecalendar: "Google Calendar",
  notion: "Notion",
  github: "GitHub",
};
export const DEFAULT_TOOLKITS = "slack,linear,twitter,gmail,googledocs,googlesheets,googlecalendar,notion,github";

/** Apps are on when the operator set the Composio key; there is no other switch. */
export function appsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.COMPOSIO_API_KEY;
}

/** PURE: the toolkits the operator allows (OBS_APPS_TOOLKITS), lower-cased, in order, without repeats. */
export function allowedToolkits(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const s of (env.OBS_APPS_TOOLKITS ?? DEFAULT_TOOLKITS).split(",")) {
    const v = s.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function appName(slug: string): string {
  return APP_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const NICKNAMES: Record<string, string> = { x: "twitter", tweet: "twitter", docs: "googledocs", googledoc: "googledocs", sheets: "googlesheets", calendar: "googlecalendar", gcal: "googlecalendar", mail: "gmail", email: "gmail" };

/** PURE: an app as a person names it ("Slack", "x", "google docs", "twitter") to its toolkit slug among the allowed ones, or null. */
export function resolveApp(text: string, allowed: string[] = allowedToolkits()): string | null {
  const t = squash(text ?? "");
  if (!t) return null;
  const nick = NICKNAMES[t];
  if (nick && allowed.includes(nick)) return nick;
  for (const slug of allowed) if (slug === t || squash(appName(slug)) === t) return slug;
  return allowed.find((slug) => slug.startsWith(t) || squash(appName(slug)).startsWith(t)) ?? null;
}

export interface AppStatus {
  slug: string;
  name: string;
  connected: boolean;
}

/** PURE: the allowed apps against the toolkits that have an active account, in the allowed order. */
export function appStatuses(allowed: string[], activeSlugs: string[]): AppStatus[] {
  const active = new Set(activeSlugs.map((s) => s.toLowerCase()));
  return allowed.map((slug) => ({ slug, name: appName(slug), connected: active.has(slug) }));
}

const userIdFor = (address: string): string => address.toLowerCase();
/** The MCP server id on the gateway for a wallet's apps: hex is a safe slug. */
export const mcpIdFor = (address: string): string => `apps-${address.toLowerCase().replace(/^0x/, "")}`;
const shortAddr = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;

let client: Composio | null = null;
function composio(): Composio {
  if (!client) client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  return client;
}

const attachedAt = new Map<string, number>();
const ATTACH_TTL_MS = 60 * 60 * 1000;

/**
 * Attach this wallet's apps to its agent: a Composio session for the wallet (its allowed toolkits, connections
 * managed from inside the conversation), the session's MCP endpoint registered on the gateway under this wallet's
 * id and enabled for this wallet's agent alone, and a policy so that running a tool inside an app waits for the
 * person's approval while searching for tools and managing connections do not. Throttled per wallet.
 */
export async function ensureApps(address: string): Promise<{ attached: boolean; reason?: string }> {
  if (!appsOn()) return { attached: false, reason: "apps_off" };
  const gw = gateway();
  if (!gw) return { attached: false, reason: "gateway_unconfigured" };
  const id = mcpIdFor(address);
  const last = attachedAt.get(id);
  if (last && Date.now() - last < ATTACH_TTL_MS) return { attached: true };
  const session = await composio().sessions.create(userIdFor(address), {
    toolkits: allowedToolkits(),
    mcp: true,
    manageConnections: { enable: true, callbackUrl: process.env.OBS_APPS_CALLBACK_URL || "https://obscura.markets/console" },
  });
  await gw.registerMcpServer({ id, name: "Your apps", description: `The apps the wallet ${shortAddr(address)} connected through the OBS console.`, url: session.mcp.url, headers: session.mcp.headers as Record<string, string> });
  const agentId = agentIdForWallet(address);
  await gw.enableMcpServer(id, agentId);
  await gw.upsertPolicy(agentId, { resourceType: "tool", resourceKey: `mcp__${id}__COMPOSIO_MULTI_EXECUTE_TOOL`, effect: "require_approval", grants: [{ type: "any" }] });
  attachedAt.set(id, Date.now());
  return { attached: true };
}

/** Which of the allowed apps this wallet has connected. */
export async function listApps(address: string): Promise<AppStatus[]> {
  const r = await composio().connectedAccounts.list({ userIds: [userIdFor(address)], statuses: ["ACTIVE"] });
  return appStatuses(allowedToolkits(), r.items.map((a) => a.toolkit.slug));
}

/** A link the person opens to connect one app; Composio runs the OAuth and keeps the tokens. */
export async function connectApp(address: string, slug: string): Promise<{ url: string | null; id: string }> {
  const r = await composio().toolkits.authorize(userIdFor(address), slug);
  return { url: r.redirectUrl ?? null, id: r.id };
}

/** Remove every account this wallet has for one app; the count removed. */
export async function disconnectApp(address: string, slug: string): Promise<number> {
  const r = await composio().connectedAccounts.list({ userIds: [userIdFor(address)], toolkitSlugs: [slug] });
  let n = 0;
  for (const a of r.items) {
    await composio().connectedAccounts.delete(a.id);
    n++;
  }
  return n;
}
