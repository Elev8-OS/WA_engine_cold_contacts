import { db, getState, setState } from './db.js';

/**
 * Wählt die nächste Variante für einen Step.
 *
 * Kein reiner Zufall: reiner Zufall klumpt und schickt dieselbe Variante
 * dreimal hintereinander. Stattdessen wird zufällig aus den am wenigsten
 * benutzten Varianten gezogen — gleichmässige Verteilung über den Pool,
 * und die letzte Variante wird übersprungen, solange es Alternativen gibt.
 */
export function pickVariant(step = 1) {
  const rows = db
    .prepare('SELECT * FROM variants WHERE active = 1 AND step = ? ORDER BY sent_count ASC, id ASC')
    .all(step);

  if (rows.length === 0) return null;

  const lowest = rows[0].sent_count;
  let candidates = rows.filter((r) => r.sent_count === lowest);

  const lastId = getState(`last_variant_step_${step}`);
  if (candidates.length > 1 && lastId) {
    const withoutLast = candidates.filter((r) => r.id !== lastId);
    if (withoutLast.length > 0) candidates = withoutLast;
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  setState(`last_variant_step_${step}`, chosen.id);
  return chosen;
}

export function markVariantSent(variantId) {
  db.prepare('UPDATE variants SET sent_count = sent_count + 1 WHERE id = ?').run(variantId);
}

export function markVariantReplied(variantId) {
  db.prepare('UPDATE variants SET reply_count = reply_count + 1 WHERE id = ?').run(variantId);
}

export function render(body, contact) {
  const first = (contact?.first_name || '').trim();
  return body
    .replaceAll('{{first_name}}', first || 'there')
    .replaceAll('{{First_Name}}', first || 'There')
    .trim();
}

/** Pool aus JSON laden. Bestehende Varianten werden nach id aktualisiert. */
export function upsertVariants(list) {
  const stmt = db.prepare(`
    INSERT INTO variants (id, step, label, body, active)
    VALUES (@id, @step, @label, @body, @active)
    ON CONFLICT(id) DO UPDATE SET
      step = excluded.step,
      label = excluded.label,
      body = excluded.body,
      active = excluded.active
  `);
  const run = db.transaction((items) => {
    for (const v of items) {
      stmt.run({
        id: v.id,
        step: v.step ?? 1,
        label: v.label ?? null,
        body: v.body,
        active: v.active === false ? 0 : 1,
      });
    }
  });
  run(list);
  return list.length;
}

/** Varianten inklusive Text — für den Editor. */
export function listVariants() {
  return db
    .prepare('SELECT id, step, label, body, active, sent_count, reply_count FROM variants ORDER BY step ASC, id ASC')
    .all()
    .map((v) => ({ ...v, active: v.active === 1 }));
}

export function deleteVariant(id) {
  const info = db.prepare('DELETE FROM variants WHERE id = ?').run(id);
  return info.changes > 0;
}

export function poolStats() {
  return db
    .prepare(
      `SELECT id, step, label, active, sent_count, reply_count,
              CASE WHEN sent_count > 0
                   THEN ROUND(CAST(reply_count AS REAL) / sent_count, 3)
                   ELSE NULL END AS reply_rate
       FROM variants ORDER BY step ASC, id ASC`
    )
    .all();
}
