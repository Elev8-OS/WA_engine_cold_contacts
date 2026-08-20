import fs from 'node:fs';
import path from 'node:path';

// Minimaler .env-Loader — keine Dependency nötig.
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const num = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

export const config = {
  ghl: {
    token: process.env.GHL_TOKEN || '',
    locationId: process.env.GHL_LOCATION_ID || '',
    versionConversations: process.env.GHL_API_VERSION_CONVERSATIONS || '2021-04-15',
    versionContacts: process.env.GHL_API_VERSION_CONTACTS || '2021-07-28',
    fromNumber: process.env.GHL_FROM_NUMBER || '',
    baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
  },
  pace: {
    timezone: process.env.TZ || 'Asia/Makassar',
    dailyCap: num('DAILY_CAP', 30),
    windowStart: num('SEND_WINDOW_START', 9),
    windowEnd: num('SEND_WINDOW_END', 18),
    minGapSeconds: num('MIN_GAP_SECONDS', 240),
    maxGapSeconds: num('MAX_GAP_SECONDS', 900),
    followupAfterHours: num('FOLLOWUP_AFTER_HOURS', 48),
    maxMessagesWithoutReply: num('MAX_MESSAGES_WITHOUT_REPLY', 2),
  },
  audience: {
    // smartlist | tag | manual
    type: process.env.AUDIENCE_SOURCE || 'manual',
    id: process.env.AUDIENCE_ID || '',
    syncIntervalMinutes: num('AUDIENCE_SYNC_INTERVAL_MINUTES', 60),
    pruneOnSync: bool('AUDIENCE_PRUNE_ON_SYNC', true),
  },
  guard: {
    replyRateWindow: num('REPLY_RATE_WINDOW', 25),
    replyRateFloor: num('REPLY_RATE_FLOOR', 0.2),
    replyRateMinSample: num('REPLY_RATE_MIN_SAMPLE', 15),
  },
  ops: {
    port: num('PORT', 3000),
    dataDir: process.env.DATA_DIR || './data',
    adminKey: process.env.ADMIN_KEY || '',
    dryRun: bool('DRY_RUN', false),
    startPaused: bool('START_PAUSED', true),
  },
};

export function assertConfig() {
  const problems = [];
  if (!config.ghl.token) problems.push('GHL_TOKEN fehlt');
  if (!config.ghl.locationId) problems.push('GHL_LOCATION_ID fehlt');
  if (!config.ops.adminKey || config.ops.adminKey.length < 16) {
    problems.push('ADMIN_KEY fehlt oder ist kürzer als 16 Zeichen');
  }
  if (config.pace.minGapSeconds > config.pace.maxGapSeconds) {
    problems.push('MIN_GAP_SECONDS ist grösser als MAX_GAP_SECONDS');
  }
  if (config.pace.windowStart >= config.pace.windowEnd) {
    problems.push('SEND_WINDOW_START muss kleiner als SEND_WINDOW_END sein');
  }
  return problems;
}
