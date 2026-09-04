// The live stream, passed through unbuffered. Vercel buffers the body of a
// plain rewrite to an external host, which turns server-sent events into
// silence; an edge function can return the upstream body as a stream. The
// upstream is the same destination as the rewrites in vercel.json.
export const config = { runtime: "edge" };

export default async function handler(req) {
  const upstream = process.env.OBS_API_UPSTREAM;
  if (!upstream) return new Response("OBS_API_UPSTREAM is not set", { status: 500 });
  const url = new URL(req.url);
  const target = `${upstream.replace(/\/+$/, "")}/api/obs/stream${url.search}`;
  const origin = req.headers.get("origin") ?? "";
  const res = await fetch(target, { headers: { Accept: "text/event-stream", Origin: origin } });
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Accel-Buffering", "no");
  const allow = res.headers.get("access-control-allow-origin");
  if (allow) headers.set("Access-Control-Allow-Origin", allow);
  return new Response(res.body, { status: res.status, headers });
}
