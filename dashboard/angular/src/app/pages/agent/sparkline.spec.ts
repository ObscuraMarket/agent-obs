import { SPARK_H, SPARK_W, sparkline } from './sparkline';

describe('the realized sparkline', () => {
  it('is a flat line at zero with a note before the second exit', () => {
    const none = sparkline([]);
    expect(none.line).toBe(`M6 ${SPARK_H / 2} L${SPARK_W - 6} ${SPARK_H / 2}`);
    expect(none.zero).toBe(SPARK_H / 2);
    expect(none.cls).toBe('flat');
    expect(none.note).toContain('No exit yet');
    const one = sparkline([{ at: 1, usd: -3.5 }]);
    expect(one.cls).toBe('flat');
    expect(one.note).toContain('-$3.50');
    expect(one.label).toContain('One exit');
  });

  it('scales to the data with zero in view, x by exit time, and is coloured by where it ends', () => {
    const s = sparkline([{ at: 0, usd: 5 }, { at: 50, usd: -5 }, { at: 100, usd: 10 }]);
    // Highest 10 at the top, lowest -5 at the bottom, 108 units between; zero sits two thirds of the way down.
    expect(s.line).toBe('M6 42 L300 114 L594 6');
    expect(s.zero).toBe(78);
    expect(s.cls).toBe('up');
    expect(s.note).toBeNull();
    expect(s.label).toContain('3 exits');
    expect(sparkline([{ at: 0, usd: -1 }, { at: 1, usd: -2 }]).cls).toBe('down');
    expect(sparkline([{ at: 0, usd: 3 }, { at: 1, usd: 0 }]).cls).toBe('flat');
  });

  it('keeps zero in the picture when every point is above it, so the line is read against break-even', () => {
    const s = sparkline([{ at: 0, usd: 4 }, { at: 10, usd: 8 }]);
    expect(s.zero).toBe(SPARK_H - 6);
    expect(s.line).toBe('M6 60 L594 6');
  });

  it('falls back to the index when every exit shares one stamp, and a book that never left zero sits on the baseline', () => {
    expect(sparkline([{ at: 7, usd: 1 }, { at: 7, usd: 2 }, { at: 7, usd: 3 }]).line).toBe('M6 78 L300 42 L594 6');
    const flat = sparkline([{ at: 0, usd: 0 }, { at: 1, usd: 0 }]);
    expect(flat.line).toBe(`M6 ${SPARK_H / 2} L594 ${SPARK_H / 2}`);
    expect(flat.zero).toBe(SPARK_H / 2);
  });
});
