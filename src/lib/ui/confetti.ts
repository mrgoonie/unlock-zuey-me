/**
 * Lightweight confetti burst on a temporary full-screen canvas (no dependency). Skipped entirely under
 * reduced motion. The canvas is aria-hidden, ignores pointer events and removes itself after ~2.4s.
 */
import { prefersReducedMotion } from './reduced-motion';

const COLORS = ['#e8592e', '#2f7d6d', '#f2b84b', '#ff8a63', '#5cc4ae', '#8f6bd8'];

export function fireConfetti(pieces = 110): void {
  if (typeof document === 'undefined' || prefersReducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  const g = canvas.getContext('2d');
  if (!g) return;
  document.body.appendChild(canvas);
  g.scale(dpr, dpr);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const parts = Array.from({ length: pieces }, () => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.3,
    y: h * 0.35,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 4,
    size: 5 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));
  const start = performance.now();
  const frame = (t: number) => {
    const elapsed = t - start;
    g.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.vy += 0.25;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      g.save();
      g.globalAlpha = Math.max(0, 1 - elapsed / 2400);
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      g.restore();
    }
    if (elapsed < 2400) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
