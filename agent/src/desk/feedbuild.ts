// The feed builder's loop: a round every OBS_FEEDBUILD_EVERY_SEC (300), the
// scout's cadence, so a closed hour's row lands within five minutes of the
// boundary, inside the stability read's two-hour freshness. One process, like
// the pollers; the round itself lives in feedrows.ts. It took the feed
// puller's place in scripts/run.sh on 2026-09-08: the watcher that feed was
// pulled from stopped on 2026-09-07, and the puller had logged a 404 every
// five seconds since.
import { feedbuildRound, roundLine } from "./feedrows.ts";

const EVERY = Number(process.env.OBS_FEEDBUILD_EVERY_SEC ?? 300);
const FILE = process.env.OBS_CANDIDATE_FEED?.trim() ?? "";
if (!FILE) {
  console.log("[feedbuild] OBS_CANDIDATE_FEED is needed; nothing to build");
  process.exit(0);
}
console.log(`[feedbuild] every ${EVERY} s: one hourly row per closed hour for up to ${process.env.OBS_FEEDBUILD_MAX_POOLS ?? 120} pools into ${FILE}, ${process.env.OBS_FEEDBUILD_HISTORY_H ?? 8} h of history at first sight, young launches ${Number(process.env.OBS_FEEDBUILD_YOUNG_H ?? 0) > 0 ? `up to ${process.env.OBS_FEEDBUILD_YOUNG_H} h old` : "off"}`);
for (;;) {
  const t0 = Date.now();
  try {
    const s = await feedbuildRound(t0);
    console.log(`[feedbuild] ${roundLine(s, (Date.now() - t0) / 1000)}`);
  } catch (e) {
    console.log(`[feedbuild] ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
