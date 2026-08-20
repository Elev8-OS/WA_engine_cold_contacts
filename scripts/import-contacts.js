#!/usr/bin/env node
/**
 * Kontakte aus CSV importieren.
 *
 *   node scripts/import-contacts.js contacts.csv
 *
 * Erwartete Spalten (Header nötig, Reihenfolge beliebig):
 *   contact_id   – GHL Contact ID  (bevorzugt)
 *   first_name   – Vorname für {{first_name}}
 *   phone        – E.164, z. B. +6281234567890
 *
 * Ohne contact_id wird über die GHL-Suche nach der Telefonnummer aufgelöst.
 */
import fs from 'node:fs';
import { db, logEvent } from '../src/db.js';
import { searchContacts } from '../src/ghl.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Nutzung: node scripts/import-contacts.js <datei.csv>');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
const header = rows.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
const idx = (name) => header.indexOf(name);

const stmt = db.prepare(`
  INSERT INTO contacts (contact_id, first_name, phone, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(contact_id) DO UPDATE SET
    first_name = COALESCE(excluded.first_name, contacts.first_name),
    phone = COALESCE(excluded.phone, contacts.phone)
`);

let imported = 0;
let skipped = 0;

for (const row of rows) {
  const get = (name) => {
    const i = idx(name);
    return i === -1 ? '' : (row[i] || '').trim();
  };

  let contactId = get('contact_id') || get('contactid') || get('id');
  const firstName = get('first_name') || get('firstname') || get('name') || null;
  const phone = get('phone') || get('phone_number') || null;

  if (!contactId && phone) {
    try {
      const found = await searchContacts(phone, 5);
      const match = found.find((c) => (c.phone || '').replace(/\D/g, '').endsWith(phone.replace(/\D/g, '').slice(-8)));
      contactId = match?.id || found[0]?.id || '';
      if (contactId) console.log(`  ${phone} → ${contactId}`);
    } catch (e) {
      console.warn(`  Suche für ${phone} fehlgeschlagen: ${e.message}`);
    }
  }

  if (!contactId) {
    console.warn(`  übersprungen (keine contact_id): ${phone || firstName || JSON.stringify(row)}`);
    skipped++;
    continue;
  }

  stmt.run(contactId, firstName, phone, Date.now());
  imported++;
}

logEvent('info', `CSV-Import: ${imported} Kontakte, ${skipped} übersprungen`);
console.log(`\nFertig: ${imported} importiert, ${skipped} übersprungen.`);
