// Zielgruppen-Sync gegen den Mock. Aufruf: node test/audience.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockGhl } from './mock-ghl.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-test-'));
process.env.DATA_DIR = tmp;
process.env.GHL_BASE_URL = 'http://localhost:4444';
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
process.env.SEND_WINDOW_START = '0';
process.env.SEND_WINDOW_END = '23';
process.env.MIN_GAP_SECONDS = '0';
process.env.MAX_GAP_SECONDS = '0';

const { server, state } = await startMockGhl(4444);

const { db } = await import('../src/db.js');
const audience = await import('../src/audience.js');
const { tick, resume } = await import('../src/campaign.js');
const { upsertVariants } = await import('../src/pool.js');

upsertVariants(JSON.parse(fs.readFileSync('pool.json', 'utf8')));

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`);
};
const queued = () => db.prepare("SELECT COUNT(*) c FROM contacts WHERE status='queued'").get().c;
const total = () => db.prepare('SELECT COUNT(*) c FROM contacts').get().c;

console.log('\n1) Smart Lists auflisten');
const lists = await audience.availableSmartLists();
check('zwei Listen gefunden', lists.length, 2);
check('Name und ID gemappt', lists[0], { id: 'sl1', name: 'Bali Villa Connect Besucher', count: 3 });

console.log('\n2) Smart List als Quelle setzen und syncen');
audience.setAudience({ type: 'smartlist', id: 'sl1', label: 'Bali Villa Connect Besucher' });
let r = await audience.syncAudience();
check('Weg = smartlist', r.path, 'smartlist');
check('3 Mitglieder', r.members, 3);
check('3 neu', r.added, 3);
check('3 in der Queue', queued(), 3);

console.log('\n3) Re-Sync ist idempotent');
r = await audience.syncAudience();
check('0 neu', r.added, 0);
check('0 entfernt', r.pruned, 0);
check('immer noch 3 in der Queue', queued(), 3);

console.log('\n4) Bereits angeschriebener Kontakt wird beim Re-Sync nicht zurückgesetzt');
resume();
await tick();
const sentContact = db.prepare("SELECT contact_id FROM contacts WHERE status='sent'").get();
check('ein Kontakt auf sent', !!sentContact, true);
r = await audience.syncAudience();
check(
  'bleibt auf sent',
  db.prepare('SELECT status FROM contacts WHERE contact_id = ?').get(sentContact.contact_id).status,
  'sent'
);
check('kein Doppel-Insert', total(), 3);

console.log('\n5) Aus der Liste entfernt: queued fliegt raus, sent bleibt');
const removedQueued = db.prepare("SELECT contact_id FROM contacts WHERE status='queued' LIMIT 1").get().contact_id;
state.smartListMembers = state.smartListMembers.filter(
  (c) => c.id !== removedQueued && c.id !== sentContact.contact_id
);
r = await audience.syncAudience();
check('genau einer entfernt', r.pruned, 1);
check(
  'entfernter queued ist weg',
  db.prepare('SELECT 1 FROM contacts WHERE contact_id = ?').get(removedQueued),
  undefined
);
check(
  'sent-Kontakt bleibt erhalten',
  !!db.prepare('SELECT 1 FROM contacts WHERE contact_id = ?').get(sentContact.contact_id),
  true
);

console.log('\n6) Tag-Quelle über die Search-API');
state.smartListMembers = [
  { id: 'ct1', firstName: 'Made', phone: '+62811111111', tags: ['cha08-invite'] },
  { id: 'ct2', firstName: 'Sarah', phone: '+62822222222', tags: ['cha08-invite'] },
  { id: 'ct3', firstName: 'Tom', phone: '+62833333333', tags: ['other'] },
];
audience.setAudience({ type: 'tag', id: 'cha08-invite', label: 'cha08-invite' });
r = await audience.syncAudience();
check('Weg = search', r.path, 'search');
check('nur die zwei getaggten', r.members, 2);

console.log('\n7) Search-API kaputt: Fallback auf Vollscan mit clientseitigem Filter');
state.searchFails = true;
r = await audience.syncAudience();
check('Weg = fullscan', r.path, 'fullscan');
check('trotzdem nur die zwei getaggten', r.members, 2);
state.searchFails = false;

console.log('\n8) Probe bei funktionierender API');
let p = await audience.probe();
check('Smart Lists ok', p.smartLists.ok, true);
check('Mitglieder ok', p.smartListMembers.ok, true);
check('Empfehlung = smartlist', p.recommendation.includes('Smart List direkt nutzbar'), true);

console.log('\n9) Probe wenn Smart Lists 404 geben');
state.smartListsFail = true;
p = await audience.probe();
check('Smart Lists nicht ok', p.smartLists.ok, false);
check('Empfehlung verweist auf Tag', p.recommendation.includes('Typ "tag"'), true);
state.smartListsFail = false;

console.log('\n10) Quelle manual macht keinen Sync');
audience.setAudience({ type: 'manual' });
r = await audience.syncAudience();
check('übersprungen', !!r.skipped, true);

console.log('\n11) Unbekannter Typ wird abgelehnt');
let threw = false;
try { audience.setAudience({ type: 'quatsch', id: 'x' }); } catch { threw = true; }
check('wirft', threw, true);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Alle Checks bestanden.' : failures + ' Checks fehlgeschlagen.'}\n`);
process.exit(failures === 0 ? 0 : 1);
