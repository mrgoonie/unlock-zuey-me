/**
 * Public certificate lookup for /certificates/:code (server only). Reads the certificates table by code;
 * revoked or unknown codes return null (404). The snapshot JSON is parsed defensively because it is
 * written by the engine module and may evolve.
 */
import { COMPETENCIES, type CompetencyId } from '../content/schema';

export interface PublicCertificate {
  code: string;
  displayName: string;
  level: string;
  issuedAt: string;
  competencies: Array<{ id: CompetencyId; score: number }>;
  missionsCompleted: number | null;
}

export const CERT_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

const isCompetency = (id: unknown): id is CompetencyId => typeof id === 'string' && (COMPETENCIES as readonly string[]).includes(id);
const score01 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);

/** Accepts `{competencies: [{id, score}]}` or `{competencies: {id: score}}`, plus optional mission counts. */
export function parseSnapshot(raw: unknown): Pick<PublicCertificate, 'competencies' | 'missionsCompleted'> {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const rawComp = obj.competencies;
  const entries: Array<[unknown, unknown]> = Array.isArray(rawComp)
    ? rawComp.map((c) => [(c as { id?: unknown })?.id, (c as { score?: unknown })?.score])
    : rawComp && typeof rawComp === 'object' ? Object.entries(rawComp) : [];
  const competencies = entries
    .map(([id, s]) => (isCompetency(id) && score01(s) !== null ? { id, score: score01(s)! } : null))
    .filter((c): c is { id: CompetencyId; score: number } => c !== null);
  const missions = obj.missionsCompleted ?? obj.completedMissions;
  const missionsCompleted = typeof missions === 'number' ? missions : Array.isArray(missions) ? missions.length : null;
  return { competencies, missionsCompleted };
}

export async function getPublicCertificate(db: D1Database | undefined, code: string): Promise<PublicCertificate | null> {
  if (!db || !CERT_CODE_RE.test(code)) return null;
  const row = await db
    .prepare('SELECT code, display_name, level, snapshot_json, issued_at FROM certificates WHERE code = ? AND revoked_at IS NULL')
    .bind(code)
    .first<{ code: string; display_name: string; level: string; snapshot_json: string; issued_at: string }>();
  if (!row) return null;
  return { code: row.code, displayName: row.display_name, level: row.level, issuedAt: row.issued_at, ...parseSnapshot(row.snapshot_json) };
}
