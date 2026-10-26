/** Results CTAs: transfer variant (prove the skill on new data), next recommended mission, share. */
import { useEffect, useState } from 'react';
import type { Mission } from '../../lib/content/schema';
import type { MissionListItem } from '../../lib/learning/types';
import { api } from '../../lib/ui/api-client';
import { pct } from '../../lib/ui/labels';
import { pickNextMission } from '../../lib/ui/results-helpers';

export default function ResultsNextSteps({ mission, score }: { mission: Mission; score: number }) {
  const [next, setNext] = useState<MissionListItem | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listMissions()
      .then(({ missions }) => { if (alive) setNext(pickNextMission(missions, mission.id, mission.transfer_variant ? [mission.transfer_variant] : [])); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [mission.id, mission.transfer_variant]);

  async function share() {
    const url = `${window.location.origin}/missions/${mission.id}`;
    const text = `Mình vừa hoàn thành “${mission.title}” trên AI Unlocked (đạt ${pct(score)}%). Học dùng AI bằng việc thật, có kiểm chứng!`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'AI Unlocked', text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      setShareNote('Đã sao chép lời khoe và đường dẫn. Dán vào Zalo/Messenger nhé!');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setShareNote('Chưa chia sẻ được. Bạn có thể chụp màn hình kết quả này.');
    }
  }

  return (
    <nav aria-label="Làm gì tiếp theo" className="flex flex-col gap-2">
      {mission.transfer_variant && (
        <a href={`/missions/${mission.transfer_variant}`} className="btn-primary" data-testid="cta-transfer">
          Thử biến thể mới (dùng kỹ năng với dữ liệu khác) →
        </a>
      )}
      {next && (
        <a href={`/missions/${next.id}`} className={mission.transfer_variant ? 'btn-ghost' : 'btn-primary'} data-testid="cta-next">
          {next.emoji} Mission tiếp: {next.title}
        </a>
      )}
      <button type="button" className="btn-ghost" onClick={share} data-testid="cta-share">📣 Khoe thành quả</button>
      <a href="/home" className="btn-ghost">Về trang chủ</a>
      {shareNote && <p className="text-center text-sm text-ink-muted" role="status">{shareNote}</p>}
    </nav>
  );
}
