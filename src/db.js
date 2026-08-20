import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.ops.dataDir, { recursive: true });

export const db = new Database(path.join(config.ops.dataDir, 'rotator.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS variants (
  id          TEXT PRIMARY KEY,
  step        INTEGER NOT NULL DEFAULT 1,
  label       TEXT,
  body        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  sent_count  INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  contact_id     TEXT PRIMARY KEY,
  first_name     TEXT,
  phone          TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  step           INTEGER NOT NULL DEFAULT 0,
  last_sent_at   INTEGER,
  replied_at     INTEGER,
  opted_out_at   INTEGER,
  note           TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  TEXT NOT NULL,
  variant_id  TEXT NOT NULL,
  step        INTEGER NOT NULL,
  body        TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  message_id  TEXT,
  replied     INTEGER NOT NULL DEFAULT 0,
  replied_at  INTEGER,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sends_sent_at ON sends(sent_at);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
`);

const getStateStmt = db.prepare('SELECT value FROM state WHERE key = ?');
const setStateStmt = db.prepare(`
  INSERT INTO state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

export function getState(key, fallback = null) {
  const row = getStateStmt.get(key);
  return row ? row.value : fallback;
}

export function setState(key, value) {
  setStateStmt.run(key, String(value));
}

const logStmt = db.prepare('INSERT INTO events (at, level, message) VALUES (?, ?, ?)');

export function logEvent(level, message) {
  logStmt.run(Date.now(), level, message);
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${level.toUpperCase()} ${message}`);
  // Ringpuffer — die letzten 500 Einträge reichen für den Betrieb.
  db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)');
}
