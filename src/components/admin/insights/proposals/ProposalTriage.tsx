/**
 * Proposal triage board: columns in workflow order (đề xuất → trùng lặp / chấp nhận / từ chối → đã tạo
 * issue → đã triển khai → đang theo dõi), the automation panel, and the detail of the selected proposal.
 * Shows only aggregates (counts, risk, gate reasons); never learner data.
 */
import { useState } from 'react';
import { errorMessage } from '../../../settings/settings-api';
import OperatorAutomationSettings from './OperatorAutomationSettings';
import ProposalDetail from './ProposalDetail';
import {
  CATEGORY_LABELS, DECISION_LABELS, proposalsApi, RISK_LABELS, STATUS_COLUMNS, STATUS_LABELS,
  type AutomationSettings, type ProposalSummary,
} from './proposals-admin-api';

interface Props {
  initialProposals: ProposalSummary[];
  initialSettings: AutomationSettings;
}

export default function ProposalTriage({ initialProposals, initialSettings }: Props) {
  const [proposals, setProposals] = useState(initialProposals);
  const [settings, setSettings] = useState(initialSettings);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await proposalsApi.list();
      setProposals(r.proposals);
      setSettings(r.settings);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const column = (status: string) => proposals.filter((p) => p.status === status || (status === 'issue_filed' && p.status === 'filing'));

  return (
    <div className="flex flex-col gap-4">
      <OperatorAutomationSettings settings={settings} onChange={setSettings} />
      {error && <p role="alert" className="card text-danger">{error}</p>}
      {selected && (
        <ProposalDetail id={selected} settings={settings} onClose={() => setSelected(null)} onChanged={refresh} />
      )}
      {proposals.length === 0 ? (
        <p className="card text-ink-muted">Chưa có đề xuất nào. Đề xuất xuất hiện khi đủ người học (đã đồng ý) gặp cùng một vấn đề.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2" role="list" aria-label="Các cột trạng thái đề xuất">
          {STATUS_COLUMNS.map((status) => {
            const items = column(status);
            return (
              <section key={status} role="listitem" className="flex w-72 shrink-0 flex-col gap-2" aria-label={STATUS_LABELS[status]}>
                <h2 className="text-sm font-semibold">{STATUS_LABELS[status]} <span className="text-ink-muted">({items.length})</span></h2>
                {items.map((p) => (
                  <button key={p.id} type="button" onClick={() => setSelected(p.id)}
                    className={`card min-h-[44px] text-left text-sm ${selected === p.id ? 'ring-2 ring-accent' : ''}`}>
                    <span className="block font-medium">{p.title}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <span className="chip">{CATEGORY_LABELS[p.category] ?? p.category}</span>
                      <span className="chip">{RISK_LABELS[p.risk]}</span>
                      {p.status === 'filing' && <span className="chip">{STATUS_LABELS.filing}</span>}
                      {p.aiHandle && <span className="chip">ai-handle</span>}
                    </span>
                    <span className="mt-1 block text-ink-muted">{p.stats.learners} người học · {p.stats.occurrences} lần</span>
                    <span className="block text-ink-muted">{DECISION_LABELS[p.gate.decision]}</span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
