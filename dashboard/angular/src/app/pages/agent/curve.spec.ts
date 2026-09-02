import { buildCurve, curveYAt, traceCurve } from './curve';

describe('chart curve', () => {
  // A wiggly series in pixel space, like an equity line.
  const px = [64, 120, 176, 232, 288, 344, 400];
  const py = [180, 90, 130, 60, 150, 100, 40];
  const curve = buildCurve(px, py);

  it('passes through every sample', () => {
    px.forEach((x, i) => expect(curveYAt(curve, x)).toBeCloseTo(py[i], 9));
  });

  it('differs from the straight chord between samples (the bug the crosshair had)', () => {
    let maxGap = 0;
    for (let i = 0; i < px.length - 1; i++) {
      const xm = (px[i] + px[i + 1]) / 2;
      const chord = (py[i] + py[i + 1]) / 2;
      maxGap = Math.max(maxGap, Math.abs(curveYAt(curve, xm) - chord));
    }
    expect(maxGap).toBeGreaterThan(1);
  });

  it('evaluates exactly the bezier segments the stroke draws', () => {
    // Record the bezier control points traceCurve emits, then compare the
    // evaluator against a direct de Casteljau evaluation of those segments.
    const segs: number[][] = [];
    const ctx = {
      lineTo: () => {},
      bezierCurveTo: (...a: number[]) => { segs.push(a); }
    } as unknown as CanvasRenderingContext2D;
    traceCurve(ctx, curve);
    expect(segs.length).toBe(px.length - 1);
    segs.forEach(([x1, y1, x2, y2, x3, y3], i) => {
      const x0 = px[i], y0 = py[i];
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const u = 1 - t;
        const bx = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const by = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        expect(curveYAt(curve, bx)).toBeCloseTo(by, 6);
      }
    });
  });

  it('never overshoots between two samples', () => {
    for (let i = 0; i < px.length - 1; i++) {
      const lo = Math.min(py[i], py[i + 1]), hi = Math.max(py[i], py[i + 1]);
      for (let k = 1; k < 20; k++) {
        const yv = curveYAt(curve, px[i] + ((px[i + 1] - px[i]) * k) / 20);
        expect(yv).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(yv).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('clamps outside the curve and handles two points linearly', () => {
    expect(curveYAt(curve, 0)).toBe(py[0]);
    expect(curveYAt(curve, 999)).toBe(py[py.length - 1]);
    const two = buildCurve([0, 100], [0, 50]);
    expect(curveYAt(two, 50)).toBeCloseTo(25, 9);
  });
});
