// The scout's loop: a round every OBS_SCOUT_EVERY_SEC (300), reading each
// survivor's last hour and ranking the board for the live watch. One process,
// like the pollers; the round itself lives in scout.ts.
import { scoutRound } from "./scout.ts";

const EVERY = Number(process.env.OBS_SCOUT_EVERY_SEC ?? 300);
console.log(`[scout] every ${EVERY} s: the board's survivors read and ranked for the watch`);
for (;;) {
  const t0 = Date.now();
  try {
    const f = await scoutRound(t0);
    console.log(`[scout] ${f.ranked.length} ranked in ${((Date.now() - t0) / 1000).toFixed(0)} s${f.ranked.length ? `: ${f.ranked.map((r) => `${r.symbol} ${r.score}`).join(", ")}` : ""}`);
  } catch (e) {
    console.log(`[scout] ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
