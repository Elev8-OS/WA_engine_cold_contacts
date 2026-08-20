import { config } from './config.js';
import { db, getState, setState, logEvent } from './db.js';

/**
 * Einstellungen zur Laufzeit.
 *
 * Die Railway-Variablen sind nur noch Startwerte. Was hier über /settings
 * gespeichert wird, liegt in der Datenbank auf dem Volume, gilt sofort und
 * überlebt Redeploys — kein Neustart, keine Variable anfassen.
 */

const PREFIX = 'set_';

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD oder leer. */
function isValidDate(v) {
  if (v === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const SPEC = [
  // ── Tempo ─────────────────────────────────────────────────────────────────
  {
    key: 'dailyCap',
    group: 'Tempo',
    label: 'Nachrichten pro Tag',
    hint: 'Harte Obergrenze pro Kalendertag in der eingestellten Zeitzone.',
    type: 'int',
    min: 1,
    max: 500,
    def: () => config.pace.dailyCap,
  },
  {
    key: 'windowStart',
    group: 'Tempo',
    label: 'Sendefenster ab (Stunde)',
    hint: 'Vorher wird nichts gesendet.',
    type: 'int',
    min: 0,
    max: 23,
    def: () => config.pace.windowStart,
  },
  {
    key: 'windowEnd',
    group: 'Tempo',
    label: 'Sendefenster bis (Stunde)',
    hint: 'Ab dieser Stunde wird nichts mehr gesendet. Muss grösser als der Start sein.',
    type: 'int',
    min: 1,
    max: 24,
    def: () => config.pace.windowEnd,
  },
  {
    key: 'timezone',
    group: 'Tempo',
    label: 'Zeitzone',
    hint: 'Basis für Sendefenster und Tages-Cap. Z. B. Asia/Makassar.',
    type: 'string',
    validate: (v) => (isValidTimezone(v) ? null : 'unbekannte Zeitzone'),
    def: () => config.pace.timezone,
  },
  {
    key: 'minGapSeconds',
    group: 'Tempo',
    label: 'Abstand minimal (Sekunden)',
    hint: 'Der echte Abstand wird pro Send zufällig zwischen Minimum und Maximum gewählt.',
    type: 'int',
    min: 0,
    max: 14400,
    def: () => config.pace.minGapSeconds,
  },
  {
    key: 'maxGapSeconds',
    group: 'Tempo',
    label: 'Abstand maximal (Sekunden)',
    hint: 'Muss mindestens so gross sein wie das Minimum.',
    type: 'int',
    min: 0,
    max: 14400,
    def: () => config.pace.maxGapSeconds,
  },
  {
    key: 'campaignEndsAt',
    group: 'Tempo',
    label: 'Kampagne endet am',
    hint: 'YYYY-MM-DD. Ab diesem Tag wird nichts mehr gesendet, auch wenn die Warteschlange voll ist. Leer = kein Ende.',
    type: 'date',
    def: () => '',
  },

  // ── Follow-up ───────────────────────────────────────────────────────────
  {
    key: 'followupAfterHours',
    group: 'Follow-up',
    label: 'Follow-up nach (Stunden)',
    hint: '0 schaltet Follow-ups ganz ab.',
    type: 'int',
    min: 0,
    max: 720,
    def: () => config.pace.followupAfterHours,
  },
  {
    key: 'maxMessagesWithoutReply',
    group: 'Follow-up',
    label: 'Max. Nachrichten ohne Antwort',
    hint: 'Die dritte unbeantwortete Nachricht holt die Spam-Reports. 2 ist ein guter Wert.',
    type: 'int',
    min: 1,
    max: 5,
    def: () => config.pace.maxMessagesWithoutReply,
  },

  // ── Bremsen ─────────────────────────────────────────────────────────────
  {
    key: 'replyRateFloor',
    group: 'Bremsen',
    label: 'Reply-Rate Minimum (0–1)',
    hint: 'Fällt die Rate darunter, pausiert die Kampagne selbst. 0.2 = 20 Prozent.',
    type: 'float',
    min: 0,
    max: 1,
    def: () => config.guard.replyRateFloor,
  },
  {
    key: 'replyRateWindow',
    group: 'Bremsen',
    label: 'Reply-Rate über die letzten N Sends',
    type: 'int',
    min: 5,
    max: 500,
    def: () => config.guard.replyRateWindow,
  },
  {
    key: 'replyRateMinSample',
    group: 'Bremsen',
    label: 'Bremse greift erst ab N Sends',
    hint: 'Verhindert, dass ein langsamer Start sofort pausiert.',
    type: 'int',
    min: 1,
    max: 500,
    def: () => config.guard.replyRateMinSample,
  },

  // ── Zielgruppe & Betrieb ─────────────────────────────────────────────────
  {
    key: 'syncIntervalMinutes',
    group: 'Betrieb',
    label: 'Zielgruppen-Sync alle (Minuten)',
    hint: 'Wie oft die Smart List neu abgeglichen wird.',
    type: 'int',
    min: 5,
    max: 1440,
    def: () => config.audience.syncIntervalMinutes,
  },
  {
    key: 'pruneOnSync',
    group: 'Betrieb',
    label: 'Beim Sync aus der Queue entfernen',
    hint: 'Kontakte, die nicht mehr in der Liste sind und noch nichts bekommen haben, fliegen raus. Bereits angeschriebene bleiben immer.',
    type: 'bool',
    def: () => config.audience.pruneOnSync,
  },
  {
    key: 'dryRun',
    group: 'Betrieb',
    label: 'Testmodus (nichts wird gesendet)',
    hint: 'Alles wird geloggt und gezählt, aber kein echter Send. Zum Prüfen von Rotation und Rendering.',
    type: 'bool',
    def: () => config.ops.dryRun,
  },
];

const byKey = new Map(SPEC.map((s) => [s.key, s]));

function coerce(spec, raw) {
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
  }
  if (spec.type === 'int' || spec.type === 'float') {
    const n = spec.type === 'int' ? parseInt(String(raw), 10) : parseFloat(String(raw));
    if (!Number.isFinite(n)) throw new Error(`${spec.key}: keine Zahl`);
    if (spec.min !== undefined && n < spec.min) throw new Error(`${spec.key}: kleiner als ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw new Error(`${spec.key}: grösser als ${spec.max}`);
    return n;
  }
  const s = String(raw).trim();
  if (spec.type === 'date' && !isValidDate(s)) {
    throw new Error(`${spec.key}: erwartet YYYY-MM-DD oder leer`);
  }
  const problem = spec.validate?.(s);
  if (problem) throw new Error(`${spec.key}: ${problem}`);
  return s;
}

let cache = null;

/** Aktuelle Werte: DB, sonst Env-Default. */
export function settings() {
  if (cache) return cache;
  const out = {};
  for (const spec of SPEC) {
    const stored = getState(PREFIX + spec.key, null);
    if (stored === null) {
      out[spec.key] = spec.def();
    } else {
      try {
        out[spec.key] = coerce(spec, stored);
      } catch {
        out[spec.key] = spec.def();
      }
    }
  }
  cache = out;
  return out;
}

export function invalidateSettings() {
  cache = null;
}

/** Welche Werte kommen aus der DB, welche noch aus den Railway-Variablen. */
export function settingsDetail() {
  const values = settings();
  return SPEC.map((spec) => ({
    key: spec.key,
    group: spec.group,
    label: spec.label,
    hint: spec.hint || '',
    type: spec.type,
    min: spec.min,
    max: spec.max,
    value: values[spec.key],
    source: getState(PREFIX + spec.key, null) === null ? 'env' : 'db',
    envDefault: spec.def(),
  }));
}

/**
 * Patch speichern. Validiert alles zuerst und schreibt erst dann — ein
 * ungültiger Wert lässt den ganzen Patch scheitern, statt halb zu greifen.
 */
export function setSettings(patch) {
  const clean = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const spec = byKey.get(key);
    if (!spec) throw new Error(`unbekannte Einstellung: ${key}`);
    clean[key] = coerce(spec, raw);
  }

  const next = { ...settings(), ...clean };
  if (next.windowStart >= next.windowEnd) {
    throw new Error('Sendefenster: Startstunde muss kleiner als Endstunde sein');
  }
  if (next.minGapSeconds > next.maxGapSeconds) {
    throw new Error('Abstand: Minimum darf nicht grösser als das Maximum sein');
  }
  if (next.replyRateMinSample > next.replyRateWindow) {
    throw new Error('Bremse: "greift ab N Sends" darf nicht grösser als das Fenster sein');
  }

  const write = db.transaction((entries) => {
    for (const [key, value] of entries) {
      setState(PREFIX + key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
    }
  });
  write(Object.entries(clean));
  invalidateSettings();

  const changed = Object.entries(clean).map(([k, v]) => `${k}=${v}`).join(', ');
  if (changed) logEvent('info', `Einstellungen geändert: ${changed}`);
  return settings();
}

/** Einen Wert auf den Railway-Default zurücksetzen. */
export function resetSetting(key) {
  if (!byKey.has(key)) throw new Error(`unbekannte Einstellung: ${key}`);
  db.prepare('DELETE FROM state WHERE key = ?').run(PREFIX + key);
  invalidateSettings();
  logEvent('info', `Einstellung ${key} auf den Startwert zurückgesetzt`);
  return settings();
}

/**
 * Ist die Kampagne über ihr Enddatum hinaus?
 * Verglichen wird der lokale Kalendertag in der eingestellten Zeitzone.
 */
export function campaignEnded(localDayString) {
  const end = settings().campaignEndsAt;
  if (!end) return false;
  return localDayString > end;
}
