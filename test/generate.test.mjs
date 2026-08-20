// Varianten-Generator gegen den Mock. Aufruf: node test/generate.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockAnthropic } from './mock-anthropic.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-test-'));
process.env.DATA_DIR = tmp;
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
process.env.ANTHROPIC_BASE_URL = 'http://localhost:4477';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
delete process.env.ANTHROPIC_MODEL;

const { server, state } = await startMockAnthropic(4477);
const G = await import('../src/generate.js');
const { db } = await import('../src/db.js');

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`);
};
const rejects = async (name, fn, mustContain) => {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  const ok = msg !== null && (!mustContain || msg.includes(mustContain));
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok ? '' : `\n         Fehler war: ${msg}`}`);
};

const BRIEF =
  'CHA-08 am 12. September um 18 Uhr im Alchemy Canggu. Zielgruppe: Villa-Owner und Manager vom Bali Villa Connect. Thema: Occupancy- und ADR-Zahlen aus 40+ Villen. 25 Platze, gratis. Ziel: Antwort, dann schicke ich den Link.';

console.log('\n1) Modellauswahl ohne ANTHROPIC_MODEL');
const model = await G.resolveModel();
check('neuestes Sonnet gewaehlt', model, 'claude-sonnet-4-5-20260101');
check('Modell-Liste wurde geholt', state.calls.some((c) => c.path === '/v1/models'), true);

console.log('\n2) Modellwahl wird gecacht');
const callsBefore = state.calls.filter((c) => c.path === '/v1/models').length;
await G.resolveModel();
check('kein zweiter Listen-Call', state.calls.filter((c) => c.path === '/v1/models').length, callsBefore);

console.log('\n3) Generieren');
const r = await G.generateVariants({ brief: BRIEF, language: 'Englisch', countStep1: 4, countStep2: 3 });
check('leerer Text wurde verworfen', r.variants.length, 4);
check('Steps korrekt verteilt', [r.variants.filter(v => v.step === 1).length, r.variants.filter(v => v.step === 2).length], [3, 1]);
check('alle IDs eindeutig', new Set(r.variants.map(v => v.id)).size, r.variants.length);
check('IDs mit Step-Prefix', r.variants.every(v => v.id.startsWith('s' + v.step + '-')), true);
check('Sonderzeichen aus der ID entfernt', r.variants[1].id, 's1-frage-zuerst-bold');
check('Dedupe haengt Zaehler an', r.variants[2].id, 's1-frage-zuerst-bold-2');
check('active gesetzt', r.variants.every(v => v.active === true), true);
check('Zeichenzahl mitgegeben', r.variants[0].chars, r.variants[0].body.length);
check('Notes durchgereicht', r.notes.startsWith('Datum fehlte'), true);
check('Warnung dabei', r.warning.includes('nicht gespeichert'), true);

console.log('\n4) Der Pool bleibt unangetastet');
check('keine Variante gespeichert', db.prepare('SELECT COUNT(*) c FROM variants').get().c, 0);

console.log('\n5) Der Prompt traegt die Regeln');
const msgCall = state.calls.filter((c) => c.path === '/v1/messages').at(-1);
check('Tool erzwungen', msgCall.toolChoice, { type: 'tool', name: 'emit_variants' });
check('API-Version-Header', msgCall.version, '2023-06-01');
check('Key gesendet', msgCall.key, 'sk-ant-test');
for (const rule of ['Kein Link in der Erstnachricht', 'Opt-out', '{{first_name}}', 'STRUKTUR', 'step 2 = Follow-up']) {
  check('System-Prompt enthaelt "' + rule + '"', msgCall.system.includes(rule), true);
}
check('Brief im User-Prompt', msgCall.userPrompt.includes('Alchemy Canggu'), true);
check('Sprache im User-Prompt', msgCall.userPrompt.includes('Englisch'), true);
check('Anzahl im User-Prompt', msgCall.userPrompt.includes('4 Varianten für step 1'), true);

console.log('\n6) Brief wird gespeichert und wieder ausgelesen');
const b = G.getBrief();
check('Brief persistiert', b.brief, BRIEF);
check('Sprache persistiert', b.language, 'Englisch');
check('Anzahl persistiert', [b.countStep1, b.countStep2], [4, 3]);
check('Modell vermerkt', b.lastModel, 'claude-sonnet-4-5-20260101');
check('Generator aktiv', b.enabled, true);

console.log('\n7) Kollision mit bestehenden IDs');
const r2 = await G.generateVariants({
  brief: BRIEF,
  existingIds: ['s1-kontext-zuerst', 's1-kontext-zuerst-2'],
});
check('weicht auf -3 aus', r2.variants[0].id, 's1-kontext-zuerst-3');

console.log('\n8) Grenzen der Anzahl');
await G.generateVariants({ brief: BRIEF, countStep1: 99, countStep2: 99 });
const capped = state.calls.filter((c) => c.path === '/v1/messages').at(-1).userPrompt;
check('auf 8 begrenzt', capped.includes('8 Varianten'), true);

console.log('\n9) Fehlerfaelle');
await rejects('zu kurzer Brief', () => G.generateVariants({ brief: 'CHA-08' }), 'zu kurz');
state.emptyVariants = true;
await rejects('Modell liefert nichts', () => G.generateVariants({ brief: BRIEF }), 'keine Varianten');
state.emptyVariants = false;

console.log('\n10) Ohne API-Key ist der Generator aus');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-test2-'));
const proc = await import('node:child_process');
const out = proc.spawnSync(process.execPath, ['-e', `
  process.env.DATA_DIR = ${JSON.stringify(tmp2)};
  process.env.GHL_TOKEN='t'; process.env.GHL_LOCATION_ID='l';
  process.env.ADMIN_KEY='test-admin-key-1234567890'; process.env.DRY_RUN='true';
  process.env.ANTHROPIC_API_KEY='';
  const G = await import('${path.resolve('src/generate.js')}');
  console.log(JSON.stringify(G.getBrief().enabled));
  try { await G.generateVariants({ brief: 'x'.repeat(80) }); console.log('KEIN FEHLER'); }
  catch (e) { console.log(e.message); }
`], { encoding: 'utf8', cwd: process.cwd() });
const lines = out.stdout.trim().split('\n');
check('enabled false', lines[0], 'false');
check('sagt was fehlt', lines[1].includes('ANTHROPIC_API_KEY fehlt'), true);
fs.rmSync(tmp2, { recursive: true, force: true });

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'Alle Checks bestanden.' : failures + ' Checks fehlgeschlagen.'}\n`);
process.exit(failures === 0 ? 0 : 1);
