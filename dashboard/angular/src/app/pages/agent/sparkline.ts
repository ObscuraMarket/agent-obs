/**
 * The sparkline under an agent's book: its realized dollars, cumulative, one point per exit, as one SVG path. Pure,
 * so the shape is tested without a browser; the component draws what this returns and nothing more. No library:
 * the site's Agent page is relayed onto the exchange site whole, and a chart dependency would have to be relayed
 * with it (2026-09-08).
 */
export interface SparkPoint { at: number; usd: number; }
export interface Spark {
  /** The path's `d`, in the viewBox below. */
  line: string;
  /** Where zero sits, as a y in the viewBox: the dashed baseline, so a run below break-even reads as one. */
  zero: number;
  /** The last point, for the end dot; null on the flat line drawn before the second exit. */
  end: { x: number; y: number } | null;
  /** How the line is coloured: by the sign of where it ends. */
  cls: 'up' | 'down' | 'flat';
  /** What the picture says, for a reader who cannot see it. */
  label: string;
  /** The note shown under the line while it is not a line yet: fewer than two exits. */
  note: string | null;
}

export const SPARK_W = 600;
export const SPARK_H = 120;
const PAD = 6;

const round = (v: number) => Math.round(v * 100) / 100;
const dollars = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

/**
 * PURE: the path through the series, scaled to the data with zero always in view. x is exit time, so a quiet
 * month between two exits shows as one; when every exit shares one stamp x falls back to the index. y is the
 * cumulative dollars; the range spans from the lowest point to the highest, widened to include zero, so a book
 * that never went under water still shows where break-even is and a book under water is drawn below the line.
 * Fewer than two exits is a flat line at zero and a note, never an empty box.
 */
export function sparkline(series: SparkPoint[]): Spark {
  const mid = SPARK_H / 2;
  if (series.length < 2) {
    const one = series[0];
    return {
      line: `M${PAD} ${mid} L${SPARK_W - PAD} ${mid}`,
      zero: mid,
      end: null,
      cls: 'flat',
      label: one ? `One exit so far, ${dollars(one.usd)} realized.` : 'No exit yet.',
      note: one ? `One exit so far (${dollars(one.usd)}). The line starts with the second.` : 'No exit yet. The line starts with the second exit.'
    };
  }
  const usds = series.map((p) => p.usd);
  let lo = Math.min(0, ...usds);
  let hi = Math.max(0, ...usds);
  // Every exit broke even: a dollar either side, so the baseline sits mid-height rather than on the top edge.
  if (hi === lo) { lo = -1; hi = 1; }
  const span = hi - lo;
  const t0 = series[0].at;
  const t1 = series[series.length - 1].at;
  const byTime = t1 > t0;
  const innerW = SPARK_W - 2 * PAD;
  const innerH = SPARK_H - 2 * PAD;
  const x = (p: SparkPoint, i: number) => PAD + (byTime ? (p.at - t0) / (t1 - t0) : i / (series.length - 1)) * innerW;
  const y = (usd: number) => PAD + ((hi - usd) / span) * innerH;
  const pts = series.map((p, i) => ({ x: round(x(p, i)), y: round(y(p.usd)) }));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  const last = series[series.length - 1].usd;
  const cls: Spark['cls'] = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  return {
    line,
    zero: round(y(0)),
    end: pts[pts.length - 1],
    cls,
    label: `Realized over ${series.length} exits: from ${dollars(series[0].usd)} after the first to ${dollars(last)} after the last, lowest ${dollars(Math.min(...usds))}, highest ${dollars(Math.max(...usds))}.`,
    note: null
  };
}
