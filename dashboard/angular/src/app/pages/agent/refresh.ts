/**
 * The Agent page's polling clock. One read of /api/obs/dashboard every fifteen seconds while the tab is shown; on a
 * 429 the wait doubles until a read succeeds, up to five minutes, so a page the desk has told to slow down does.
 * Until 2026-09-08 the page polled nine routes on a fixed fifteen-second interval, hidden or not, and a 429 changed
 * nothing.
 */
export const REFRESH_MS = 15_000;
export const REFRESH_MAX_MS = 5 * 60_000;

/**
 * PURE: the wait before the next read. `failedStatus` is null when the read succeeded, else the HTTP status it
 * failed with (0 when the request never got an answer). A success goes back to the clock; a 429 doubles the wait,
 * capped; any other failure keeps the wait as it is, since a redeploy's 502 is not a reason to slow down.
 */
export function nextRefreshMs(current: number, failedStatus: number | null): number {
  if (failedStatus === null) { return REFRESH_MS; }
  if (failedStatus === 429) { return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MS, current) * 2); }
  return current;
}
