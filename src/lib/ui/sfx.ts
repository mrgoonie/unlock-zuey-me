/**
 * Tiny WebAudio-synthesized sound effects (no audio files). Sound is opt-in: callers pass
 * learner.profile.sound === true as `enabled`, so the default is silent.
 */
type Tone = { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number };

/** Tiny synthesized sounds (WebAudio), so no audio files ship with the app. */
const SOUNDS = {
  success: [
    { freq: 523.25, at: 0, dur: 0.14 }, { freq: 659.25, at: 0.1, dur: 0.14 }, { freq: 783.99, at: 0.2, dur: 0.28 },
  ],
  badge: [
    { freq: 880, at: 0, dur: 0.1, type: 'triangle' }, { freq: 1174.66, at: 0.09, dur: 0.22, type: 'triangle' },
  ],
  tick: [{ freq: 1200, at: 0, dur: 0.03, type: 'square', gain: 0.03 }],
  gentle: [{ freq: 392, at: 0, dur: 0.18, type: 'sine' }, { freq: 349.23, at: 0.14, dur: 0.24, type: 'sine' }],
} satisfies Record<string, Tone[]>;

export type SoundName = keyof typeof SOUNDS;

let ctx: AudioContext | null = null;

/** Plays a short sound when `enabled`. Never throws (autoplay policies, missing AudioContext). */
export function playSound(name: SoundName, enabled: boolean): void {
  if (!enabled || typeof window === 'undefined') return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    for (const t of SOUNDS[name] as Tone[]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = t.type ?? 'sine';
      osc.frequency.value = t.freq;
      const peak = t.gain ?? 0.08;
      g.gain.setValueAtTime(0.0001, now + t.at);
      g.gain.exponentialRampToValueAtTime(peak, now + t.at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t.at + t.dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + t.at);
      osc.stop(now + t.at + t.dur + 0.02);
    }
  } catch {
    /* sound is decoration only */
  }
}
