// Browser-Check des Blätterns. Kein Teil von npm test (braucht Playwright).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-ui-'));
process.env.DATA_DIR = tmp;
process.env.GHL_TOKEN = 'test-token';
process.env.GHL_LOCATION_ID = 'loc1';
process.env.ADMIN_KEY = 'test-admin-key-1234567890';
process.env.DRY_RUN = 'true';
process.env.PORT = '4123';
process.env.TZ = 'Asia/Makassar';

const { db, logEvent } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');

const insC = db.prepare('INSERT INTO contacts (contact_id, first_name, created_at) VALUES (?,?,?)');
const insS = db.prepare(
  'INSERT INTO sends (contact_id, variant_id, step, body, sent_at, replied, error) VALUES (?,?,?,?,?,?,?)'
);
for (let i = 0; i < 80; i++) {
  insC.run('c' + i, 'Kontakt ' + i, Date.now());
  insS.run('c' + i, 's1-frage', 1, 'Hallo', 1_700_000_000_000 + i * 60000, i % 3 === 0 ? 1 : 0, i % 10 === 0 ? 'boom' : null);
}
for (let i = 0; i < 60; i++) logEvent(i % 5 === 0 ? 'warn' : 'info', 'Logzeile ' + i);

const server = createServer().listen(4123);
const base = 'http://127.0.0.1:4123';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(base + '/');
await page.fill('#lk', 'test-admin-key-1234567890');
await page.click('#lbtn');
await page.waitForLoadState('networkidle');

const txt = async (sel) => (await page.textContent(sel))?.trim();
console.log('Sends-Zähler:            ', await txt('#sendpager [data-role="count"]'));
console.log('Log-Zähler:              ', await txt('#logpager [data-role="count"]'));
console.log('Sends-Zeilen Seite 1:    ', await page.locator('#sendrows tr').count());

const firstRow = await txt('#sendrows tr:first-child td:nth-child(2)');
await page.click('#sendpager [data-role="next"]');
await page.waitForTimeout(400);
console.log('nach weiter, Zähler:     ', await txt('#sendpager [data-role="count"]'));
console.log('erste Zeile geaendert:   ', (await txt('#sendrows tr:first-child td:nth-child(2)')) !== firstRow);
console.log('zurueck aktiv:           ', !(await page.isDisabled('#sendpager [data-role="prev"]')));

await page.selectOption('#sendpager [data-role="size"]', '100');
await page.waitForTimeout(400);
console.log('Seitengroesse 100:       ', await txt('#sendpager [data-role="count"]'),
  '/ Zeilen:', await page.locator('#sendrows tr').count());

await page.selectOption('#sendpager [data-role="filter"]', 'errors');
await page.waitForTimeout(400);
console.log('Filter Fehler:           ', await txt('#sendpager [data-role="count"]'));

await page.fill('#sendpager [data-role="q"]', 'Kontakt 7');
await page.waitForTimeout(800);
console.log('Fehler + Suche Kontakt 7:', await txt('#sendpager [data-role="count"]'));

await page.selectOption('#logpager [data-role="filter"]', 'warn');
await page.waitForTimeout(400);
console.log('Log nur warn:            ', await txt('#logpager [data-role="count"]'));
await page.selectOption('#logpager [data-role="size"]', '25');
await page.selectOption('#logpager [data-role="filter"]', 'all');
await page.waitForTimeout(400);
await page.click('#logpager [data-role="next"]');
await page.waitForTimeout(400);
console.log('Log Seite 2:             ', await txt('#logpager [data-role="count"]'));
await page.click('#logpager [data-role="first"]');
await page.waitForTimeout(400);
console.log('Log zurueck auf Anfang:  ', await txt('#logpager [data-role="count"]'));

await page.screenshot({ path: '/home/claude/pager.png', fullPage: true });

// Ohne Anmeldung darf es keine Pager geben, aber die Gesamtzahl schon.
const anon = await browser.newContext();
const anonPage = await anon.newPage();
await anonPage.goto(base + '/');
console.log('anonym Pager vorhanden:  ', await anonPage.locator('#sendpager').count());
const anonRes = await anonPage.request.get(base + '/api/sends');
console.log('anonym /api/sends:       ', anonRes.status());

console.log('JS-Fehler:               ', errors.length ? errors : 'keine');

await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
