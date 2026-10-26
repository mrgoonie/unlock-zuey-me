/**
 * Geometry for the competency radar (plain SVG, no chart library). Axis 0 points straight up and axes go
 * clockwise. Values are clamped to [0, 1]; coordinates are rounded to 2 decimals for stable SSR markup.
 */
export interface Point { x: number; y: number }

const round = (n: number) => Math.round(n * 100) / 100;

/** Point on axis `i` of `n` at `fraction` (0..1) of `radius` from the centre. */
export function axisPoint(i: number, n: number, fraction: number, radius: number, cx: number, cy: number): Point {
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
  const r = radius * Math.max(0, Math.min(1, fraction));
  return { x: round(cx + r * Math.cos(angle)), y: round(cy + r * Math.sin(angle)) };
}

export const toPoints = (pts: Point[]): string => pts.map((p) => `${p.x},${p.y}`).join(' ');

export interface RadarModel {
  /** Concentric grid rings (polygons) at 25/50/75/100%. */
  rings: string[];
  axes: Array<{ end: Point; label: Point; anchor: 'start' | 'middle' | 'end' }>;
  /** Learner polygon. */
  shape: string;
  dots: Point[];
}

export function radarModel(values: number[], size: number, padding = 44): RadarModel {
  const n = values.length;
  if (n < 3) throw new Error('radar needs at least 3 axes');
  const c = size / 2;
  const radius = c - padding;
  const rings = [0.25, 0.5, 0.75, 1].map((f) => toPoints(values.map((_, i) => axisPoint(i, n, f, radius, c, c))));
  const axes = values.map((_, i) => {
    const end = axisPoint(i, n, 1, radius, c, c);
    const label = axisPoint(i, n, 1, radius + 18, c, c);
    const anchor: 'start' | 'middle' | 'end' = Math.abs(label.x - c) < 1 ? 'middle' : label.x > c ? 'start' : 'end';
    return { end, label, anchor };
  });
  const dots = values.map((v, i) => axisPoint(i, n, v, radius, c, c));
  return { rings, axes, shape: toPoints(dots), dots };
}
