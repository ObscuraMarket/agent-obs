// The public URL of the API bridge right now, from the tunnel service's log,
// checked live. `npm run bridge:url`. Hand it to the site team for a test:
// the page takes it as ?api=<url> and remembers it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const log = `${homedir()}/Library/Logs/obs-tunnel.log`;
let url = "";
try {
  const m = readFileSync(log, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com|https:\/\/[a-z0-9.-]+\.(?:obscura\.market|obscuracex\.com)/g);
  url = m ? m[m.length - 1] : "";
} catch {}
if (!url) { console.log("no bridge URL in the tunnel log; is com.obscura.obstunnel loaded?"); process.exit(1); }
try {
  const r = await fetch(`${url}/api/obs/health`, { signal: AbortSignal.timeout(15000) });
  const ok = r.ok && (await r.json()).status === "ok";
  console.log(`${url}  ${ok ? "answers" : `HTTP ${r.status}`}`);
  console.log(`page test: http://127.0.0.1:4200/?api=${url}`);
} catch (e) {
  console.log(`${url}  (not reachable from this machine: ${e instanceof Error ? e.message : e}; this Mac's resolver may lag on new names, the URL can still be fine elsewhere)`);
}
