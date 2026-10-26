/**
 * Gentle Vietnamese reminder copy. The variant is picked deterministically from a seed (subscription id +
 * local day) so copy varies day to day but a retry within the same day would say the same thing.
 */

export interface ReminderCopy {
  title: string;
  body: string;
  /** Site-relative path the notification opens. */
  path: string;
  tag: string;
  variant: number;
}

const WITH_MISSION: Array<(title: string) => [string, string]> = [
  (t) => ['Mình làm tiếp nhé? 🌱', `Mission “${t}” đang chờ bạn. Chỉ vài phút là xong một bước.`],
  (t) => ['Còn dở một chút thôi', `Quay lại “${t}” nhé, bài làm của bạn vẫn được giữ nguyên.`],
  (t) => ['5 phút với AI hôm nay?', `Làm tiếp “${t}” rồi tự kiểm chứng kết quả nào.`],
];

const WITHOUT_MISSION: Array<[string, string]> = [
  ['5 phút với AI hôm nay? ☕', 'Chọn một việc nhỏ, nhờ AI giúp rồi tự kiểm chứng nhé.'],
  ['Hôm nay thử một mission nhé', 'Một việc thật, vài phút thôi. Gợi ý đã sẵn sàng cho bạn.'],
  ['Nhắc nhẹ từ AI Unlocked', 'Mỗi ngày một chút là đủ. Ghé qua làm một bước nhỏ nhé.'],
];

/** Small stable string hash (FNV-1a) used only to pick a copy variant. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export function buildReminderCopy(seed: string, mission?: { id: string; title: string } | null): ReminderCopy {
  const h = hashSeed(seed);
  if (mission) {
    const variant = h % WITH_MISSION.length;
    const [title, body] = WITH_MISSION[variant](clamp(mission.title, 60));
    return { title, body, path: `/missions/${encodeURIComponent(mission.id)}`, tag: 'daily-reminder', variant };
  }
  const variant = h % WITHOUT_MISSION.length;
  const [title, body] = WITHOUT_MISSION[variant];
  return { title, body, path: '/home', tag: 'daily-reminder', variant };
}
