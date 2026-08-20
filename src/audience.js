import { config } from './config.js';
import { db, getState, setState, logEvent } from './db.js';
import {
  listSmartLists,
  getSmartListContacts,
  searchContacts_advanced,
  listAllContacts,
  listLocationTags,
  rawGet,
} from './ghl.js';

/** Kontakt-Objekte aus verschiedenen GHL-Endpoints auf eine Form bringen. */
function normalize(c) {
  const id = c.id || c._id || c.contactId;
  if (!id) return null;
  return {
    contact_id: String(id),
    first_name: c.firstName || c.first_name || c.firstNameLowerCase || null,
    phone: c.phone || c.phoneNumber || null,
    tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t).toLowerCase()) : [],
  };
}

export function getAudience() {
  return {
    type: getState('audience_type', config.audience.type),
    id: getState('audience_id', config.audience.id),
    label: getState('audience_label', ''),
    lastSyncAt: Number(getState('audience_last_sync_at', '0')) || null,
    lastSyncResult: getState('audience_last_sync_result', ''),
    lastSyncPath: getState('audience_last_sync_path', ''),
  };
}

export function setAudience({ type, id, label }) {
  if (!['smartlist', 'tag', 'manual'].includes(type)) {
    throw new Error(`Unbekannter Zielgruppen-Typ: ${type}`);
  }
  if (type !== 'manual' && !id) throw new Error('id fehlt (Smart-List-ID oder Tag-Name)');
  setState('audience_type', type);
  setState('audience_id', id || '');
  setState('audience_label', label || '');
  logEvent('info', `Zielgruppe gesetzt: ${type}${id ? ` = ${label || id}` : ''}`);
  return getAudience();
}

/**
 * Smart Lists für die Auswahl holen.
 * Auf vielen Locations nicht verfügbar — HighLevel hat dafür keinen
 * dokumentierten v2-Endpoint. Der Aufruf wirft dann, /audience zeigt es an.
 */
export async function availableSmartLists() {
  return listSmartLists({ limit: 200 });
}

/** Tags der Location für die Auswahl — dokumentiert und überall verfügbar. */
export async function availableTags() {
  return listLocationTags();
}

/**
 * Endpoint-Scanner für Smart Lists.
 *
 * HighLevel hat für Smart Lists keinen dokumentierten v2-Endpoint. Statt zu
 * raten, probiert das hier eine Reihe plausibler Pfade gegen die echte Location
 * und zeigt Statuscode und Antwort. Was 200 liefert, ist der Weg.
 */
export async function discoverSmartLists() {
  const loc = config.ghl.locationId;
  const candidates = [
    { path: '/contacts/smart-lists', query: { locationId: loc, limit: 5 } },
    { path: '/contacts/smartlists', query: { locationId: loc, limit: 5 } },
    { path: '/contacts/lists', query: { locationId: loc, limit: 5 } },
    { path: '/contacts/views', query: { locationId: loc, limit: 5 } },
    { path: `/locations/${loc}/smart-lists`, query: { limit: 5 } },
    { path: `/locations/${loc}/smartlists`, query: { limit: 5 } },
    { path: `/locations/${loc}/lists`, query: { limit: 5 } },
    { path: `/locations/${loc}/contacts/smart-lists`, query: { limit: 5 } },
    { path: `/locations/${loc}/contacts/views`, query: { limit: 5 } },
    { path: '/smart-lists', query: { locationId: loc, limit: 5 } },
    { path: '/objects/contact/views', query: { locationId: loc, limit: 5 } },
    { path: `/locations/${loc}/objects/contact/views`, query: { limit: 5 } },
    { path: '/objects/contact/smart-lists', query: { locationId: loc, limit: 5 } },
    { path: '/objects/contact/records/views', query: { locationId: loc, limit: 5 } },
  ];

  const versions = [config.ghl.versionContacts, '2021-04-15'];
  const results = [];

  for (const c of candidates) {
    for (const version of versions) {
      const r = await rawGet(c.path, { query: c.query, version });
      results.push({
        endpoint: `GET ${c.path}`,
        version,
        status: r.status,
        ok: r.ok,
        // Bei 200 die Struktur zeigen, sonst die Fehlermeldung — kurz halten.
        response: r.ok
          ? JSON.stringify(r.body).slice(0, 400)
          : String(r.body?.message || r.body?.error || JSON.stringify(r.body)).slice(0, 160),
      });
      if (r.ok) break; // dieser Pfad geht, die zweite Version brauchen wir nicht
    }
  }

  const working = results.filter((r) => r.ok);
  return {
    locationId: loc ? `${loc.slice(0, 4)}…${loc.slice(-4)}` : '(fehlt)',
    tried: results.length,
    working,
    all: results,
    verdict: working.length
      ? `Treffer: ${working.map((w) => w.endpoint).join(', ')} — sag mir das, dann verdrahte ich es.`
      : 'Kein Pfad liefert 200. Smart Lists sind über die öffentliche API nicht erreichbar — ' +
        'der Tag-Weg ist die Lösung, und er hält die Liste genauso aktuell.',
  };
}

/**
 * Mitglieder der aktuellen Zielgruppe laden.
 * Liefert { members, path } — path sagt, welcher API-Weg funktioniert hat.
 */
export async function fetchMembers() {
  const { type, id } = getAudience();

  if (type === 'manual') return { members: [], path: 'manual' };

  if (type === 'smartlist') {
    const raw = await getSmartListContacts(id);
    return { members: raw.map(normalize).filter(Boolean), path: 'smartlist' };
  }

  // type === 'tag' — erst die Search-API, dann clientseitig filtern.
  const wanted = String(id).toLowerCase();
  try {
    const { contacts } = await searchContacts_advanced(
      [{ field: 'tags', operator: 'eq', value: wanted }],
      { pageLimit: 100 }
    );
    if (contacts.length > 0) {
      return { members: contacts.map(normalize).filter(Boolean), path: 'search' };
    }
    logEvent('warn', `Search-API lieferte 0 Kontakte für Tag "${wanted}" — fallback auf Vollscan`);
  } catch (e) {
    logEvent('warn', `Search-API nicht nutzbar (${e.message.slice(0, 120)}) — fallback auf Vollscan`);
  }

  const all = await listAllContacts();
  const members = all
    .map(normalize)
    .filter(Boolean)
    .filter((c) => c.tags.includes(wanted));
  return { members, path: 'fullscan' };
}

/**
 * Zielgruppe mit der Warteschlange abgleichen.
 *
 * Regeln, die hier wichtig sind:
 *  - Neue Mitglieder kommen als 'queued' dazu.
 *  - Bereits angeschriebene, geantwortete oder abgemeldete Kontakte werden NICHT
 *    zurückgesetzt. Ein Re-Sync darf niemand doppelt anschreiben.
 *  - Wer nicht mehr in der Liste ist und noch nichts bekommen hat, fliegt aus der
 *    Queue. Wer schon eine Nachricht hat, bleibt für Follow-up und Statistik drin.
 */
export async function syncAudience({ prune = true } = {}) {
  const { type, id, label } = getAudience();
  if (type === 'manual') {
    return { skipped: 'Zielgruppe steht auf manual — kein Sync' };
  }

  const started = Date.now();
  const { members, path } = await fetchMembers();
  const ids = new Set(members.map((m) => m.contact_id));

  const insert = db.prepare(`
    INSERT INTO contacts (contact_id, first_name, phone, status, step, created_at)
    VALUES (@contact_id, @first_name, @phone, 'queued', 0, @created_at)
    ON CONFLICT(contact_id) DO UPDATE SET
      first_name = COALESCE(excluded.first_name, contacts.first_name),
      phone = COALESCE(excluded.phone, contacts.phone)
  `);

  const before = db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;

  const run = db.transaction((items) => {
    for (const m of items) {
      insert.run({
        contact_id: m.contact_id,
        first_name: m.first_name,
        phone: m.phone,
        created_at: Date.now(),
      });
    }
  });
  run(members);

  const after = db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c;
  const added = after - before;

  let pruned = 0;
  if (prune && members.length > 0) {
    const queued = db.prepare("SELECT contact_id FROM contacts WHERE status = 'queued'").all();
    const stale = queued.filter((r) => !ids.has(r.contact_id)).map((r) => r.contact_id);
    if (stale.length) {
      const del = db.prepare('DELETE FROM contacts WHERE contact_id = ?');
      db.transaction((list) => list.forEach((cid) => del.run(cid)))(stale);
      pruned = stale.length;
    }
  }

  const result = {
    type,
    id,
    label,
    path,
    members: members.length,
    added,
    pruned,
    queued: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE status = 'queued'").get().c,
    tookMs: Date.now() - started,
  };

  setState('audience_last_sync_at', String(Date.now()));
  setState('audience_last_sync_path', path);
  setState(
    'audience_last_sync_result',
    `${result.members} Mitglieder · ${added} neu · ${pruned} entfernt · via ${path}`
  );
  logEvent(
    'info',
    `Sync ${type}${id ? ` "${label || id}"` : ''}: ${result.members} Mitglieder, ` +
      `${added} neu, ${pruned} entfernt, via ${path} (${result.tookMs}ms)`
  );

  return result;
}

/**
 * Prüft gegen die echte Location, welche Wege funktionieren.
 * Die Smart-List-Endpoints sind bei HighLevel nicht offiziell dokumentiert —
 * das hier sagt in einem Aufruf, ob sie auf diesem Account nutzbar sind.
 */
export async function probe() {
  const out = {};

  try {
    const lists = await listSmartLists({ limit: 5 });
    out.smartLists = { ok: true, found: lists.length, sample: lists.slice(0, 5) };
  } catch (e) {
    out.smartLists = { ok: false, error: e.message.slice(0, 200) };
  }

  if (out.smartLists.ok && out.smartLists.sample[0]?.id) {
    try {
      const members = await getSmartListContacts(out.smartLists.sample[0].id, {
        pageSize: 5,
        maxPages: 1,
      });
      out.smartListMembers = { ok: true, sampleSize: members.length };
    } catch (e) {
      out.smartListMembers = { ok: false, error: e.message.slice(0, 200) };
    }
  }

  try {
    const { contacts } = await searchContacts_advanced([], { pageLimit: 5 });
    out.contactsSearch = { ok: true, sampleSize: contacts.length };
  } catch (e) {
    out.contactsSearch = { ok: false, error: e.message.slice(0, 200) };
  }

  try {
    const all = await listAllContacts({ pageSize: 5, maxPages: 1 });
    out.listContacts = { ok: true, sampleSize: all.length };
  } catch (e) {
    out.listContacts = { ok: false, error: e.message.slice(0, 200) };
  }

  try {
    const tags = await listLocationTags();
    out.tags = { ok: true, found: tags.length, sample: tags.slice(0, 8).map((t) => t.name) };
  } catch (e) {
    out.tags = { ok: false, error: e.message.slice(0, 200) };
  }

  const tagCount = out.tags?.ok ? out.tags.found : 0;
  out.recommendation = out.smartListMembers?.ok
    ? 'Smart List direkt nutzbar — Typ "smartlist" wählen.'
    : out.contactsSearch?.ok || out.listContacts?.ok
      ? `Smart Lists hat HighLevel nicht als API-Endpoint. Nutze Typ "tag": in GHL die Smart List öffnen, alle auswählen, Bulk Action "Add Tag" — dann hier den Tag wählen.` +
        (tagCount ? ` ${tagCount} Tags stehen zur Auswahl.` : '')
      : 'Kein Weg funktioniert — Token und Scopes prüfen.';

  return out;
}
