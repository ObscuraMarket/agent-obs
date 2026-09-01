// Provision OBS's personas on the OpenHermit gateway: create each agent if
// missing (no sandbox), then
// write identity / rules / soul from personality/<agent>/*.md. Re-runnable.
// The em-dash guard is the house rule and skips a file that breaks it.
import { GatewayClient } from "@openhermit/sdk";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
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
const baseUrl = process.env.OPENHERMIT_GATEWAY_URL;
const token = process.env.GATEWAY_ADMIN_TOKEN;
if (!baseUrl || !token) {
  console.error("OPENHERMIT_GATEWAY_URL and GATEWAY_ADMIN_TOKEN are required (see .env.example).");
  process.exit(1);
}
const owner = process.env.OBS_OWNER_USER_ID || undefined;
const gw = new GatewayClient({ baseUrl, token });

const personas = {
  [process.env.OBS_AGENT_ID || "obs"]: { dir: "obs", name: "OBS" },
  [process.env.OBS_X_AGENT_ID || "obs-copywriter"]: { dir: "copywriter", name: "OBS copywriter" },
};
const load = (dir, key) => readFileSync(join(ROOT, "personality", dir, `${key}.md`), "utf8").replace(/^#\s+\w+\s*\n/, "").trim();

const existing = new Set((await gw.listAgents()).map((a) => a.agentId));
for (const [agentId, p] of Object.entries(personas)) {
  if (!existing.has(agentId)) {
    await gw.createAgent({ agentId, name: p.name, sandbox: null, ownerUserId: owner });
    console.log(`created agent: ${agentId}`);
  } else {
    console.log(`agent ${agentId} already exists, updating it`);
  }
  for (const key of ["identity", "rules", "soul"]) {
    const content = load(p.dir, key);
    if (content.includes("—")) {
      console.log(`  !! EM DASH in ${p.dir}/${key}.md, skipping`);
      continue;
    }
    await gw.setInstruction(agentId, key, content);
    console.log(`  set ${agentId}.${key} (${content.length} chars)`);
  }
  const check = await gw.listInstructions(agentId);
  const keys = (Array.isArray(check) ? check : check?.instructions ?? []).map((i) => i.key ?? i.name);
  console.log(`  ${agentId} configured with: ${keys.join(", ")}`);
}
