/**
 * Monotone cubic interpolation (Fritsch-Carlson) shared by the chart stroke and
 * the crosshair, so the hover dot rides exactly the curve that is drawn.
 */
export interface Curve { px: number[]; py: number[]; m: number[]; }

/** Tangent per point; a sign change in the neighbouring slopes flattens it (no overshoot). */
export function monotoneTangents(px: number[], py: number[]): number[] {
  const n = px.length;
  const m: number[] = new Array(n).fill(0);
  if (n < 2) { return m; }
  const dx: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = (px[i + 1] - px[i]) || 1e-6;
    slope[i] = (py[i + 1] - py[i]) / dx[i];
  }
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  return m;
}

export function buildCurve(px: number[], py: number[]): Curve {
  return { px, py, m: monotoneTangents(px, py) };
}

/** Appends the curve to the current path (the path must already be at px[0], py[0]). */
export function traceCurve(ctx: CanvasRenderingContext2D, c: Curve): void {
  const { px, py, m } = c;
  const n = px.length;
  if (n === 2) { ctx.lineTo(px[1], py[1]); return; }
  for (let i = 0; i < n - 1; i++) {
    const h = ((px[i + 1] - px[i]) || 1e-6) / 3;
    ctx.bezierCurveTo(px[i] + h, py[i] + m[i] * h, px[i + 1] - h, py[i + 1] - m[i + 1] * h, px[i + 1], py[i + 1]);
  }
}

/**
 * The y of the drawn curve at pixel x. The bezier's x control points sit at
 * thirds of each segment, so x is linear in the bezier parameter and the
 * segment can be evaluated directly. Clamps to the ends outside the curve.
 */
export function curveYAt(c: Curve, xq: number): number {
  const { px, py, m } = c;
  const n = px.length;
  if (n === 0) { return 0; }
  if (n === 1 || xq <= px[0]) { return py[0]; }
  if (xq >= px[n - 1]) { return py[n - 1]; }
  if (n === 2) { return py[0] + ((xq - px[0]) / ((px[1] - px[0]) || 1e-6)) * (py[1] - py[0]); }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (px[mid] <= xq) { lo = mid; } else { hi = mid; }
  }
  const dx = (px[hi] - px[lo]) || 1e-6, h = dx / 3;
  const t = (xq - px[lo]) / dx, u = 1 - t;
  const p0 = py[lo], p1 = py[lo] + m[lo] * h, p2 = py[hi] - m[hi] * h, p3 = py[hi];
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
