/**
 * Motion preference: off when the OS asks for reduced motion or the learner turned on "giảm chuyển động"
 * (html[data-reduced-motion], set by AppLayout from learner.profile.reducedMotion).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return true;
  if (document.documentElement.dataset.reducedMotion === 'true') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
