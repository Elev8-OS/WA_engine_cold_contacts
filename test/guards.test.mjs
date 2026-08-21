// Reifezeit der Reply-Rate und Requeue haengender Kontakte.
// Aufruf: node test/guards.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
process.env.DATA_DIR = tmp;
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
process.env.TZ = 'Asia/Makassar';

const { db } = await import('../src/db.js');
const S = await import('../src/settings.js');
const { upsertVariants } = await import('../src/pool.js');
const { tick, replyRate, requeueStuck, stats } = await import('../src/campaign.js');

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
const throws = (name, fn, part) => {
  try {
    fn();
    failures++;
    console.log(` FAIL  ${name}\n         kein Fehler geworfen`);
  } catch (e) {
    const ok = e.message.includes(part);
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         Meldung war: ${e.message}`}`);
  }
};

const H = 3600 * 1000;
const ins = db.prepare(
  "INSERT INTO sends (contact_id, variant_id, step, body, sent_at, replied) VALUES (?,?,1,'x',?,?)"
);

console.log('\n1) Reifezeit: junge Sends zaehlen nicht in die Reply-Rate');
// 10 alte Sends (48 h), davon einer mit Antwort -> reife Rate 10 %
for (let i = 0; i < 10; i++) ins.run('old' + i, 'v1', Date.now() - 48 * H, i === 0 ? 1 : 0);
// 10 frische Sends (1 h), keine Antwort -> duerfen die Rate nicht verwaessern
for (let i = 0; i < 10; i++) ins.run('new' + i, 'v1', Date.now() - 1 * H, 0);

S.setSettings({ replyRateMaturityHours: '24', replyRateWindow: '50', replyRateMinSample: '5' });
const r1 = replyRate();
check('nur die reifen zaehlen', r1.sample, 10);
check('Rate aus den reifen', Number(r1.rate.toFixed(2)), 0.1);
check('junge werden ausgewiesen', r1.maturing, 10);

S.setSettings({ replyRateMaturityHours: '0' });
const r2 = replyRate();
check('Reifezeit 0 zaehlt alles', r2.sample, 20);
check('Rate halbiert sich', Number(r2.rate.toFixed(2)), 0.05);
check('nichts mehr am Reifen', r2.maturing, 0);
S.setSettings({ replyRateMaturityHours: '24' });

console.log('\n2) Bremse pausiert nicht wegen unreifer Sends');
db.prepare('DELETE FROM sends').run();
for (let i = 0; i < 30; i++) ins.run('fresh' + i, 'v1', Date.now() - 1 * H, 0);
S.setSettings({ replyRateFloor: '0.2', replyRateWindow: '50', replyRateMinSample: '10' });
db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('paused','0')").run();
db.prepare(
  'INSERT OR REPLACE INTO contacts (contact_id, first_name, created_at) VALUES (?,?,?)'
).run('cx', 'X', Date.now());
upsertVariants([{ id: 'v1', step: 1, label: 't', body: 'Hi {{first_name}}' }]);
S.setSettings({ dailyCap: '50', minGapSeconds: '0', maxGapSeconds: '0', windowStart: '0', windowEnd: '23' });
const t = await tick();
check('sendet trotz 0% unreifer Rate', t.action, 'sent');
check('nicht pausiert', stats().paused, false);

console.log('\n3) Requeue holt haengende Kontakte zurueck, ohne Doppelversand');
db.prepare('DELETE FROM sends').run();
db.prepare('DELETE FROM contacts').run();
const c = db.prepare(
  'INSERT INTO contacts (contact_id, first_name, status, step, last_sent_at, created_at) VALUES (?,?,?,?,?,?)'
);
// A: nie gesendet, haengt auf no_variant -> zurueck in die Queue
c.run('A', 'A', 'no_variant', 0, null, Date.now());
// B: Step 1 erfolgreich, dann no_variant bei Step 2 -> zurueck auf Step 1, NICHT in die Queue
c.run('B', 'B', 'no_variant', 1, Date.now() - 50 * H, Date.now());
ins.run('B', 'v1', Date.now() - 50 * H, 0);
// C: error, aber die Nachricht ging nachweislich raus -> bleibt sent
c.run('C', 'C', 'error', 1, Date.now() - 50 * H, Date.now());
ins.run('C', 'v1', Date.now() - 50 * H, 0);
// D: error ohne erfolgreichen Send -> zurueck in die Queue
c.run('D', 'D', 'error', 0, null, Date.now());

const rq = requeueStuck();
check('vier gefunden', rq.found, 4);
check('zwei in die Queue', rq.queued, 2);
check('zwei auf letzten Step', rq.restored, 2);
const st = (id) => db.prepare('SELECT status, step FROM contacts WHERE contact_id = ?').get(id);
check('A wieder queued', st('A'), { status: 'queued', step: 0 });
check('B auf Step 1 statt Queue', st('B'), { status: 'sent', step: 1 });
check('C auf Step 1 statt Queue', st('C'), { status: 'sent', step: 1 });
check('D wieder queued', st('D'), { status: 'queued', step: 0 });
check('keine haengenden mehr', stats().stuck, 0);

console.log('\n4) Requeue ohne haengende Kontakte ist harmlos');
check('nichts gefunden', requeueStuck(), { found: 0, queued: 0, restored: 0 });

console.log('\n5) Stichprobe groesser als Fenster wird abgelehnt');
throws(
  '19 Fenster / 50 Stichprobe',
  () => S.setSettings({ replyRateWindow: '19', replyRateMinSample: '50' }),
  'greift ab N Sends'
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Alle Checks bestanden.' : failures + ' Checks fehlgeschlagen.'}\n`);
process.exit(failures === 0 ? 0 : 1);
