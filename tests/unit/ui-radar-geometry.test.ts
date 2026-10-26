import { describe, expect, it } from 'vitest';
import { axisPoint, radarModel, toPoints } from '../../src/lib/ui/radar-geometry';

describe('radar geometry', () => {
  it('puts axis 0 straight up and goes clockwise', () => {
    expect(axisPoint(0, 6, 1, 100, 150, 150)).toEqual({ x: 150, y: 50 });
    const p1 = axisPoint(1, 6, 1, 100, 150, 150);
    expect(p1.x).toBeGreaterThan(150);
    expect(p1.y).toBeLessThan(150);
    expect(axisPoint(3, 6, 1, 100, 150, 150)).toEqual({ x: 150, y: 250 });
  });

  it('clamps values to [0, 1]', () => {
    expect(axisPoint(0, 6, 2, 100, 0, 0)).toEqual(axisPoint(0, 6, 1, 100, 0, 0));
    expect(axisPoint(2, 6, -1, 100, 10, 10)).toEqual({ x: 10, y: 10 });
  });

  it('builds 4 rings, 6 axes and a shape with one point per value', () => {
    const m = radarModel([0, 0.25, 0.5, 0.75, 1, 0.5], 280);
    expect(m.rings).toHaveLength(4);
    expect(m.axes).toHaveLength(6);
    expect(m.dots).toHaveLength(6);
    expect(m.shape.split(' ')).toHaveLength(6);
    expect(m.dots[0]).toEqual({ x: 140, y: 140 });
    expect(m.axes[0].anchor).toBe('middle');
    expect(m.axes[1].anchor).toBe('start');
    expect(m.axes[5].anchor).toBe('end');
  });

  it('rejects fewer than 3 axes and formats points', () => {
    expect(() => radarModel([1, 1], 100)).toThrow();
    expect(toPoints([{ x: 1, y: 2 }, { x: 3.5, y: 4 }])).toBe('1,2 3.5,4');
  });
});
