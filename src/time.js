import { config } from './config.js';

const tz = config.pace.timezone;

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: tz,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parts(ts = Date.now()) {
  const out = {};
  for (const p of partsFormatter.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** Lokaler Kalendertag als YYYY-MM-DD — Basis für den Tages-Cap. */
export function localDay(ts = Date.now()) {
  const p = parts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localHour(ts = Date.now()) {
  const h = Number(parts(ts).hour);
  return h === 24 ? 0 : h;
}

export function localTimeLabel(ts = Date.now()) {
  const p = parts(ts);
  return `${p.hour}:${p.minute}`;
}

export function insideSendWindow(ts = Date.now()) {
  const h = localHour(ts);
  return h >= config.pace.windowStart && h < config.pace.windowEnd;
}

export function randomGapMs() {
  const { minGapSeconds, maxGapSeconds } = config.pace;
  const span = Math.max(0, maxGapSeconds - minGapSeconds);
  return (minGapSeconds + Math.floor(Math.random() * (span + 1))) * 1000;
}

export const HOUR_MS = 3_600_000;
