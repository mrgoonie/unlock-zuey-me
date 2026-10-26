import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';

describe('test D1 helper', () => {
  it('applies migrations and supports bind/first/all/batch', async () => {
    const db = createTestD1();
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('lrn_a', 'guest', now, now),
      db.prepare('INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('lrn_b', 'guest', now, now),
    ]);
    expect(await db.prepare('SELECT kind FROM learners WHERE id = ?').bind('lrn_a').first('kind')).toBe('guest');
    expect((await db.prepare('SELECT id FROM learners ORDER BY id').all()).results).toHaveLength(2);
    await expect(db.batch([
      db.prepare('INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('lrn_c', 'guest', now, now),
      db.prepare('INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('lrn_c', 'bogus', now, now),
    ])).rejects.toThrow();
    expect(await db.prepare('SELECT id FROM learners WHERE id = ?').bind('lrn_c').first()).toBeNull();
  });
});
