import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfig } from './config.js';
import { logEvent, getState, setState } from './db.js';
import { createServer } from './server.js';
import { tick } from './campaign.js';
import { upsertVariants, poolStats } from './pool.js';
import { getAudience, syncAudience } from './audience.js';
import { settings } from './settings.js';

const problems = assertConfig();
if (problems.length) {
  console.error('Konfiguration unvollständig:\n  - ' + problems.join('\n  - '));
  if (!config.ops.dryRun) process.exit(1);
}

// pool.json ist nur die Erstbefüllung. Sobald Varianten in der Datenbank liegen,
// wird die Datei ignoriert — sonst würde jeder Deploy die im Editor geschriebenen
// Texte überschreiben. Erzwingen geht über POOL_SEED_ALWAYS=true.
const poolFile = path.resolve(process.cwd(), process.env.POOL_FILE || 'pool.json');
const seedAlways = /^(1|true|yes|on)$/i.test(process.env.POOL_SEED_ALWAYS || '');
const poolIsEmpty = poolStats().length === 0;

if (fs.existsSync(poolFile) && (poolIsEmpty || seedAlways)) {
  try {
    const list = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
    const n = upsertVariants(Array.isArray(list) ? list : list.variants);
    logEvent(
      'info',
      `${n} Varianten aus ${path.basename(poolFile)} geladen` +
        (seedAlways && !poolIsEmpty ? ' (POOL_SEED_ALWAYS überschreibt den Editor)' : '')
    );
  } catch (e) {
    logEvent('error', `pool.json konnte nicht gelesen werden: ${e.message}`);
  }
} else if (!poolIsEmpty) {
  logEvent('info', `${poolStats().length} Varianten aus der Datenbank — pool.json wird ignoriert`);
}

if (poolStats().length === 0) {
  logEvent('warn', 'Pool ist leer — es wird nichts gesendet. Varianten unter /settings anlegen.');
}

if (getState('paused') === null) {
  setState('paused', config.ops.startPaused ? '1' : '0');
  setState('pause_reason', config.ops.startPaused ? 'Startzustand — über /admin/resume freigeben' : '');
}

const app = createServer();
const server = app.listen(config.ops.port, () => {
  logEvent(
    'info',
    `SMS Rotator läuft auf Port ${config.ops.port} · TZ ${settings().timezone} · ` +
      `Cap ${settings().dailyCap}/Tag · ${settings().dryRun ? 'DRY RUN' : 'LIVE'}`
  );
});

let running = false;
const interval = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (e) {
    logEvent('error', `Tick-Fehler: ${e.message}`);
  } finally {
    running = false;
  }
}, 30_000);

// Zielgruppen-Sync. Smart Lists sind dynamisch — wer neu reinrutscht, soll
// ohne Handarbeit in die Warteschlange kommen.
let syncing = false;
async function runSync(trigger) {
  if (syncing) return;
  const { type } = getAudience();
  if (type === 'manual') return;
  syncing = true;
  try {
    await syncAudience({ prune: settings().pruneOnSync });
  } catch (e) {
    logEvent('error', `Sync (${trigger}) fehlgeschlagen: ${e.message}`);
  } finally {
    syncing = false;
  }
}

// Das Intervall wird zur Laufzeit gelesen, damit eine Änderung unter /settings
// sofort greift und keinen Neustart braucht.
const syncInterval = setInterval(() => {
  const dueAfter = Math.max(5, settings().syncIntervalMinutes) * 60_000;
  const last = Number(getState('audience_last_sync_at', '0'));
  if (Date.now() - last >= dueAfter) runSync('intervall');
}, 60_000);

if (getAudience().type !== 'manual') {
  logEvent('info', `Zielgruppen-Sync alle ${settings().syncIntervalMinutes} Minuten`);
  setTimeout(() => runSync('start'), 5000);
}

const shutdown = (signal) => {
  logEvent('info', `${signal} empfangen — Shutdown`);
  clearInterval(interval);
  clearInterval(syncInterval);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
