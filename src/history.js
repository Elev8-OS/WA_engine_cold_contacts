import { db } from './db.js';

/**
 * Verlauf zum Blättern.
 *
 * Das Dashboard hat vorher die letzten 20 Sends und die letzten 15 Log-Zeilen
 * fest eingebaut. Alles Ältere war da, aber nicht sichtbar. Hier liegen die
 * Abfragen dafür: eine Seite Daten plus die Gesamtzahl, damit die Oberfläche
 * weiss, wie weit sie blättern kann.
 */

export const MAX_PAGE = 500;
const DEFAULT_PAGE = 50;

/** Seitengrösse und Position robust machen — kaputte Query-Parameter sollen nicht werfen. */
export function pageArgs({ limit, offset } = {}) {
  const l = parseInt(String(limit ?? ''), 10);
  const o = parseInt(String(offset ?? ''), 10);
  return {
    limit: Number.isFinite(l) ? Math.min(MAX_PAGE, Math.max(1, l)) : DEFAULT_PAGE,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

const SEND_FILTERS = {
  all: '',
  replied: 'AND s.replied = 1',
  open: 'AND s.replied = 0 AND s.error IS NULL',
  errors: 'AND s.error IS NOT NULL',
};

/**
 * Sends, neueste zuerst.
 * filter: all | replied | open | errors, q sucht in Name, Kontakt-ID und Variante.
 */
export function listSends({ limit, offset, filter = 'all', q = '' } = {}) {
  const page = pageArgs({ limit, offset });
  const where = SEND_FILTERS[filter] ?? '';
  const usedFilter = SEND_FILTERS[filter] === undefined ? 'all' : filter;
  const needle = String(q || '').trim();
  const search = needle
    ? 'AND (c.first_name LIKE @q OR s.contact_id LIKE @q OR s.variant_id LIKE @q)'
    : '';
  const params = { q: `%${needle}%`, limit: page.limit, offset: page.offset };

  const rows = db
    .prepare(
      `SELECT s.id, s.sent_at, s.contact_id, s.variant_id, s.step, s.replied, s.replied_at,
              s.error, s.body, c.first_name
         FROM sends s LEFT JOIN contacts c ON c.contact_id = s.contact_id
        WHERE 1=1 ${where} ${search}
        ORDER BY s.id DESC
        LIMIT @limit OFFSET @offset`
    )
    .all(params);

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM sends s LEFT JOIN contacts c ON c.contact_id = s.contact_id
        WHERE 1=1 ${where} ${search}`
    )
    .get(params).c;

  return { rows, total, limit: page.limit, offset: page.offset, filter: usedFilter, q: needle };
}

const LEVELS = new Set(['info', 'warn', 'error']);

/** Log-Zeilen, neueste zuerst. level: all | info | warn | error, q sucht in der Meldung. */
export function listEvents({ limit, offset, level = 'all', q = '' } = {}) {
  const page = pageArgs({ limit, offset });
  const lvl = LEVELS.has(level) ? level : 'all';
  const needle = String(q || '').trim();
  const where = [];
  if (lvl !== 'all') where.push('level = @level');
  if (needle) where.push('message LIKE @q');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const params = { level: lvl, q: `%${needle}%`, limit: page.limit, offset: page.offset };

  const rows = db
    .prepare(
      `SELECT id, at, level, message FROM events ${clause}
        ORDER BY id DESC LIMIT @limit OFFSET @offset`
    )
    .all(params);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events ${clause}`).get(params).c;

  return { rows, total, limit: page.limit, offset: page.offset, level: lvl, q: needle };
}
