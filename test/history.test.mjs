// Blättern in Sends und Log. Aufruf: node test/history.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-test-'));
process.env.DATA_DIR = tmp;
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
process.env.EVENT_LOG_LIMIT = '120';
process.env.TZ = 'Asia/Makassar';

const { db, logEvent } = await import('../src/db.js');
const { listSends, listEvents, pageArgs, MAX_PAGE } = await import('../src/history.js');

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${name}${
      ok ? '' : `\n         erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`
    }`
  );
};

// 120 Sends: jeder dritte mit Antwort, jeder zehnte mit Fehler.
const insC = db.prepare(
  'INSERT INTO contacts (contact_id, first_name, created_at) VALUES (?,?,?)'
);
const insS = db.prepare(
  'INSERT INTO sends (contact_id, variant_id, step, body, sent_at, replied, error) VALUES (?,?,?,?,?,?,?)'
);
for (let i = 0; i < 120; i++) {
  insC.run('c' + i, i === 7 ? 'Imelissa' : 'Kontakt ' + i, Date.now());
  insS.run(
    'c' + i,
    i % 2 === 0 ? 's1-frage' : 's2-nachfrage',
    i % 2 === 0 ? 1 : 2,
    'Hallo',
    1_700_000_000_000 + i * 1000,
    i % 3 === 0 ? 1 : 0,
    i % 10 === 0 ? 'boom' : null
  );
}

console.log('\n1) Seitengrösse und Position werden gezähmt');
check('Default 50', pageArgs({}), { limit: 50, offset: 0 });
check('Unfug faellt auf Default', pageArgs({ limit: 'viele', offset: 'weit' }), { limit: 50, offset: 0 });
check('0 wird 1', pageArgs({ limit: '0' }).limit, 1);
check('negativ wird 1', pageArgs({ limit: '-5' }).limit, 1);
check('Deckel greift', pageArgs({ limit: '99999' }).limit, MAX_PAGE);
check('negatives Offset wird 0', pageArgs({ offset: '-20' }).offset, 0);

console.log('\n2) Sends: blättern deckt alles ab, ohne Lücke und ohne Doppelte');
const first = listSends({ limit: 50 });
check('Gesamtzahl', first.total, 120);
check('erste Seite voll', first.rows.length, 50);
check('neueste zuerst', first.rows[0].sent_at > first.rows[49].sent_at, true);
const second = listSends({ limit: 50, offset: 50 });
const third = listSends({ limit: 50, offset: 100 });
check('letzte Seite kurz', third.rows.length, 20);
const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
check('alle 120 Sends gesehen', ids.length, 120);
check('keine doppelt', new Set(ids).size, 120);
check('Offset hinter dem Ende ist leer', listSends({ offset: 500 }).rows.length, 0);

console.log('\n3) Sends: Filter und Suche');
check('nur mit Antwort', listSends({ filter: 'replied', limit: 500 }).total, 40);
check('nur Fehler', listSends({ filter: 'errors', limit: 500 }).total, 12);
const open = listSends({ filter: 'open', limit: 500 });
check('offen = ohne Antwort und ohne Fehler', open.total, 72);
check('offen wirklich offen', open.rows.every((r) => r.replied === 0 && r.error === null), true);
check('unbekannter Filter zaehlt alles', listSends({ filter: 'quatsch' }).total, 120);
check('unbekannter Filter wird gemeldet', listSends({ filter: 'quatsch' }).filter, 'all');
check('Suche nach Name', listSends({ q: 'Imelissa', limit: 500 }).total, 1);
check('Suche nach Variante', listSends({ q: 's2-nachfrage', limit: 500 }).total, 60);
check('Suche nach Kontakt-ID', listSends({ q: 'c119', limit: 500 }).total, 1);
check('Suche ohne Treffer', listSends({ q: 'gibtsnicht' }).total, 0);
check('Filter und Suche zusammen', listSends({ filter: 'errors', q: 's1-frage', limit: 500 }).total, 12);

console.log('\n4) Log: blättern, Level und Suche');
for (let i = 0; i < 40; i++) logEvent(i % 4 === 0 ? 'warn' : 'info', 'Zeile ' + i);
logEvent('error', 'Versand fehlgeschlagen: boom');
const log1 = listEvents({ limit: 10 });
check('Log-Gesamtzahl', log1.total, 41);
check('Seite hat 10', log1.rows.length, 10);
check('neueste zuerst', log1.rows[0].message, 'Versand fehlgeschlagen: boom');
check('zweite Seite ist verschieden', listEvents({ limit: 10, offset: 10 }).rows[0].id < log1.rows[9].id, true);
check('nur warn', listEvents({ level: 'warn', limit: 500 }).total, 10);
check('nur error', listEvents({ level: 'error', limit: 500 }).total, 1);
check('unbekanntes Level zaehlt alles', listEvents({ level: 'debug' }).total, 41);
check('Suche in der Meldung', listEvents({ q: 'fehlgeschlagen', limit: 500 }).total, 1);
check('Level und Suche zusammen', listEvents({ level: 'info', q: 'Zeile', limit: 500 }).total, 30);

console.log('\n5) Ringpuffer: das Log waechst nicht unbegrenzt');
for (let i = 0; i < 300; i++) logEvent('info', 'Fuellzeile ' + i);
const size = listEvents({ limit: 1 }).total;
check('bleibt in der Naehe des Limits', size <= 200 && size >= 120, true);
check('neueste Zeile ist noch da', listEvents({ limit: 1 }).rows[0].message, 'Fuellzeile 299');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Alle Checks bestanden.' : failures + ' Checks fehlgeschlagen.'}\n`);
process.exit(failures === 0 ? 0 : 1);
