// A throwaway data dir for a test that drives the server's routes, set before src/server.ts is evaluated: the
// data dir is fixed when config.ts loads, so this must be the first import of a test file that reaches a route.
// Without it the route tests read the real ledgers, and one that records a follow row writes into them (2026-09-08).
// The wallet seed, the door and the gateway are off here for the same reason: no chain read for a made-up wallet,
// no agent created on the real gateway.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OBS_DATA_DIR = mkdtempSync(join(tmpdir(), "obs-test-"));
process.env.OBS_AGENT_WALLET_SEED = "";
process.env.OBS_CONSOLE_GATE = "off";
process.env.OBS_CONSOLE_ALLOWLIST = "";
process.env.OBS_TRADING = "off";
process.env.OBS_FOLLOW_LIVE = "off";
process.env.OPENHERMIT_GATEWAY_URL = "";
process.env.GATEWAY_ADMIN_TOKEN = "";
process.env.COMPOSIO_API_KEY = "";
