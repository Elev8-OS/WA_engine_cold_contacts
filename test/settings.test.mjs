// Einstellungen und Kampagnen-Ende. Aufruf: node test/settings.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'set-test-'));
process.env.DATA_DIR = tmp;
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
// Bewusst enge Env-Startwerte, damit der DB-Override sichtbar wird.
process.env.DAILY_CAP = '7';
process.env.SEND_WINDOW_START = '9';
process.env.SEND_WINDOW_END = '18';
process.env.MIN_GAP_SECONDS = '100';
process.env.MAX_GAP_SECONDS = '200';
process.env.TZ = 'Asia/Makassar';

const { db } = await import('../src/db.js');
const S = await import('../src/settings.js');
const { upsertVariants, listVariants, deleteVariant } = await import('../src/pool.js');
const { tick, resume } = await import('../src/campaign.js');
const time = await import('../src/time.js');

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`);
};
const throws = (name, fn, mustContain) => {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  const ok = msg !== null && (!mustContain || msg.includes(mustContain));
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         Fehler war: ${msg}`}`);
};

console.log('\n1) Startwerte kommen aus den Env-Variablen');
check('dailyCap aus Env', S.settings().dailyCap, 7);
check('Quelle ist env', S.settingsDetail().find((d) => d.key === 'dailyCap').source, 'env');

console.log('\n2) DB überschreibt Env und gilt sofort');
S.setSettings({ dailyCap: '42', minGapSeconds: '10', maxGapSeconds: '20' });
check('dailyCap überschrieben', S.settings().dailyCap, 42);
check('Quelle ist db', S.settingsDetail().find((d) => d.key === 'dailyCap').source, 'db');
check('Env-Default bleibt sichtbar', S.settingsDetail().find((d) => d.key === 'dailyCap').envDefault, 7);

console.log('\n3) Zurücksetzen fällt auf den Env-Startwert');
S.resetSetting('dailyCap');
check('wieder 7', S.settings().dailyCap, 7);
check('Quelle wieder env', S.settingsDetail().find((d) => d.key === 'dailyCap').source, 'env');

console.log('\n4) Validierung');
throws('unbekannter Key', () => S.setSettings({ quatsch: 1 }), 'unbekannte Einstellung');
throws('keine Zahl', () => S.setSettings({ dailyCap: 'viele' }), 'keine Zahl');
throws('unter Minimum', () => S.setSettings({ dailyCap: '0' }), 'kleiner als 1');
throws('über Maximum', () => S.setSettings({ dailyCap: '9999' }), 'grösser als 500');
throws('Fenster verdreht', () => S.setSettings({ windowStart: '18', windowEnd: '9' }), 'Startstunde');
throws('Abstand verdreht', () => S.setSettings({ minGapSeconds: '900', maxGapSeconds: '60' }), 'Minimum darf nicht');
throws('Bremse inkonsistent', () => S.setSettings({ replyRateWindow: '10', replyRateMinSample: '50' }), 'greift ab N Sends');
throws('kaputte Zeitzone', () => S.setSettings({ timezone: 'Mars/Olympus' }), 'unbekannte Zeitzone');
throws('kaputtes Datum', () => S.setSettings({ campaignEndsAt: '20.08.2026' }), 'YYYY-MM-DD');
check('nach den Fehlern unverändert', S.settings().dailyCap, 7);

console.log('\n5) Patch ist atomar — ein Fehler schreibt nichts');
throws('Patch mit einem kaputten Wert', () => S.setSettings({ dailyCap: '99', replyRateFloor: '5' }), 'grösser als 1');
check('dailyCap nicht geschrieben', S.settings().dailyCap, 7);

console.log('\n6) Zeitzone wirkt zur Laufzeit auf das Sendefenster');
S.setSettings({ timezone: 'Asia/Makassar', windowStart: '0', windowEnd: '23' });
check('im Fenster', time.insideSendWindow(), true);
S.setSettings({ windowStart: '0', windowEnd: '1' });
const hourNow = time.localHour();
check('Fenster 0–1 Uhr greift', time.insideSendWindow(), hourNow < 1);
S.setSettings({ windowStart: '0', windowEnd: '23' });

console.log('\n7) Abstand bleibt in den Grenzen');
S.setSettings({ minGapSeconds: '30', maxGapSeconds: '45' });
const gaps = Array.from({ length: 200 }, () => time.randomGapMs() / 1000);
check('nie unter dem Minimum', gaps.every((g) => g >= 30), true);
check('nie über dem Maximum', gaps.every((g) => g <= 45), true);
check('variiert wirklich', new Set(gaps).size > 1, true);

console.log('\n8) Kampagnen-Enddatum stoppt den Versand');
upsertVariants([{ id: 'v1', step: 1, label: 'test', body: 'Hi {{first_name}}' }]);
db.prepare('INSERT OR REPLACE INTO contacts (contact_id, first_name, created_at) VALUES (?,?,?)').run('c1', 'Made', Date.now());
S.setSettings({ dailyCap: '10', minGapSeconds: '0', maxGapSeconds: '0' });
resume();

const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
S.setSettings({ campaignEndsAt: yesterday });
check('Tick blockiert', (await tick()).action, 'campaign_ended');

const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
S.setSettings({ campaignEndsAt: tomorrow });
check('mit Enddatum in der Zukunft wird gesendet', (await tick()).action, 'sent');

S.setSettings({ campaignEndsAt: '' });
check('leeres Enddatum = kein Ende', S.settings().campaignEndsAt, '');

console.log('\n9) Varianten-CRUD für den Editor');
upsertVariants([
  { id: 'e1', step: 1, label: 'eins', body: 'Text eins' },
  { id: 'e2', step: 2, label: 'zwei', body: 'Text zwei', active: false },
]);
const all = listVariants();
check('Text kommt mit', all.find((v) => v.id === 'e1').body, 'Text eins');
check('active als boolean', all.find((v) => v.id === 'e2').active, false);
upsertVariants([{ id: 'e1', step: 1, label: 'eins neu', body: 'Text eins geändert' }]);
check('Update greift', listVariants().find((v) => v.id === 'e1').body, 'Text eins geändert');
check('Löschen funktioniert', deleteVariant('e2'), true);
check('Löschen von etwas Unbekanntem', deleteVariant('gibtsnicht'), false);

console.log('\n10) Kaputter Wert in der DB fällt auf den Default zurück');
db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('set_dailyCap', 'muell')").run();
S.invalidateSettings();
check('Default statt Absturz', S.settings().dailyCap, 7);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Alle Checks bestanden.' : failures + ' Checks fehlgeschlagen.'}\n`);
process.exit(failures === 0 ? 0 : 1);
