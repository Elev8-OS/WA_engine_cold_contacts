import { config } from './config.js';
import { db, getState, setState, logEvent } from './db.js';
import { sendSms, addTags } from './ghl.js';
import { pickVariant, markVariantSent, markVariantReplied, render } from './pool.js';
import { settings, campaignEnded } from './settings.js';
import { insideSendWindow, localDay, localTimeLabel, randomGapMs, HOUR_MS } from './time.js';

const STOP_WORDS = [
  'stop', 'out', 'unsubscribe', 'remove', 'no thanks', 'not interested',
  'berhenti', 'abmelden',
];

// Ein Ja ist alles, was in drei Zeichen passt - genau so sind die Nachrichten
// geschrieben. Wer laenger antwortet, bekommt keine Automatik, sondern einen
// Menschen: das ist eine offene Konversation und kein Formular.
const YES_WORDS = [
  'yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'in', 'send', 'details',
  'info', 'interested', '1', 'ya', 'iya', 'boleh', 'mau', 'ja',
];

const NO_WORDS = [
  'no', 'nope', 'nah', '2', 'later', 'not now', 'maybe later', 'pass',
  'tidak', 'nanti', 'belum', 'nein',
];

/** Antwort auf ein einzelnes Schlagwort pruefen, nicht auf einen ganzen Satz. */
function matches(clean, words) {
  const bare = clean.replace(/[.!,;:]+$/, '').trim();
  return words.some((w) => bare === w || bare.startsWith(w + ' ') || bare.startsWith(w + ','));
}

const TAG = {
  sent: 'cha08-sent',
  yes: 'cha08-yes',
  no: 'cha08-no',
  replied: 'cha08-replied',
  optedOut: 'cha08-opted-out',
};

/** Tag setzen, ohne den Ablauf zu stoppen, wenn GHL gerade klemmt. */
async function tag(contactId, name) {
  if (settings().dryRun) return;
  try {
    await addTags(contactId, [name]);
  } catch (e) {
    logEvent('warn', `Tag ${name} fuer ${contactId} fehlgeschlagen: ${e.message}`);
  }
}

export function isPaused() {
  return getState('paused', config.ops.startPaused ? '1' : '0') === '1';
}

export function pause(reason) {
  setState('paused', '1');
  setState('pause_reason', reason || 'manuell');
  logEvent('warn', `Kampagne pausiert: ${reason || 'manuell'}`);
}

export function resume() {
  setState('paused', '0');
  setState('pause_reason', '');
  logEvent('info', 'Kampagne fortgesetzt');
}

function sentToday() {
  const day = localDay();
  const rows = db.prepare('SELECT sent_at FROM sends WHERE error IS NULL').all();
  return rows.filter((r) => localDay(r.sent_at) === day).length;
}

/** Reply-Rate über die letzten N erfolgreichen Sends. */
export function replyRate() {
  const rows = db
    .prepare('SELECT replied FROM sends WHERE error IS NULL ORDER BY id DESC LIMIT ?')
    .all(settings().replyRateWindow);
  if (rows.length === 0) return { sample: 0, rate: null };
  const replies = rows.filter((r) => r.replied === 1).length;
  return { sample: rows.length, rate: replies / rows.length };
}

function checkReplyRateGuard() {
  const s = settings();
  const { sample, rate } = replyRate();
  if (sample < s.replyRateMinSample) return;
  if (rate !== null && rate < s.replyRateFloor) {
    pause(
      `Reply-Rate ${(rate * 100).toFixed(0)}% liegt unter dem Minimum von ` +
        `${(s.replyRateFloor * 100).toFixed(0)}% (letzte ${sample} Sends)`
    );
  }
}

/**
 * Nächster fälliger Kontakt.
 * Step 1 = Erstnachricht. Step 2+ = Follow-up, nur ohne Antwort und nach Wartezeit.
 */
function nextDueContact() {
  const s = settings();

  const firstTouch = db
    .prepare(
      `SELECT * FROM contacts
       WHERE status = 'queued' AND step = 0 AND opted_out_at IS NULL AND replied_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
    )
    .get();
  if (firstTouch) return { contact: firstTouch, step: 1 };

  if (s.followupAfterHours <= 0) return null;

  const cutoff = Date.now() - s.followupAfterHours * HOUR_MS;
  const followUp = db
    .prepare(
      `SELECT * FROM contacts
       WHERE status = 'sent' AND replied_at IS NULL AND opted_out_at IS NULL
         AND step >= 1 AND step < ? AND last_sent_at IS NOT NULL AND last_sent_at <= ?
       ORDER BY last_sent_at ASC LIMIT 1`
    )
    .get(s.maxMessagesWithoutReply, cutoff);
  if (followUp) return { contact: followUp, step: followUp.step + 1 };

  return null;
}

async function sendTo(contact, step) {
  // Für Step 2 den Follow-up-Pool nehmen, mit Rückfall auf Step 1.
  const variant = pickVariant(step) || (step > 1 ? pickVariant(1) : null);
  if (!variant) {
    logEvent('warn', `Keine aktive Variante für Step ${step} — Kontakt ${contact.contact_id} übersprungen`);
    db.prepare("UPDATE contacts SET status = 'no_variant' WHERE contact_id = ?").run(contact.contact_id);
    return false;
  }

  const body = render(variant.body, contact);
  const now = Date.now();

  if (settings().dryRun) {
    db.prepare(
      `INSERT INTO sends (contact_id, variant_id, step, body, sent_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(contact.contact_id, variant.id, step, body, now, 'dry-run');
    markVariantSent(variant.id);
    db.prepare(
      "UPDATE contacts SET status = 'sent', step = ?, last_sent_at = ? WHERE contact_id = ?"
    ).run(step, now, contact.contact_id);
    logEvent('info', `[DRY RUN] ${contact.contact_id} ← ${variant.id} (Step ${step})`);
    return true;
  }

  try {
    const res = await sendSms({ contactId: contact.contact_id, message: body });
    db.prepare(
      `INSERT INTO sends (contact_id, variant_id, step, body, sent_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(contact.contact_id, variant.id, step, body, now, res.messageId);
    markVariantSent(variant.id);
    db.prepare(
      "UPDATE contacts SET status = 'sent', step = ?, last_sent_at = ? WHERE contact_id = ?"
    ).run(step, now, contact.contact_id);
    logEvent('info', `Gesendet an ${contact.contact_id} — Variante ${variant.id}, Step ${step}`);
    await tag(contact.contact_id, TAG.sent);
    return true;
  } catch (e) {
    db.prepare(
      `INSERT INTO sends (contact_id, variant_id, step, body, sent_at, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(contact.contact_id, variant.id, step, body, now, String(e.message).slice(0, 500));
    db.prepare("UPDATE contacts SET status = 'error', note = ? WHERE contact_id = ?").run(
      String(e.message).slice(0, 300),
      contact.contact_id
    );
    logEvent('error', `Versand an ${contact.contact_id} fehlgeschlagen: ${e.message}`);

    const fails = db
      .prepare('SELECT COUNT(*) AS c FROM sends WHERE error IS NOT NULL AND sent_at > ?')
      .get(Date.now() - HOUR_MS).c;
    if (fails >= 5) pause(`${fails} Fehler in der letzten Stunde — API oder Nummer prüfen`);
    return false;
  }
}

/** Ein Tick. Sendet maximal eine Nachricht — das Tempo macht der Gap. */
export async function tick() {
  if (isPaused()) return { action: 'paused', reason: getState('pause_reason', '') };

  const today = localDay();
  if (campaignEnded(today)) {
    return { action: 'campaign_ended', endedAt: settings().campaignEndsAt };
  }

  if (!insideSendWindow()) {
    return { action: 'outside_window', localTime: localTimeLabel() };
  }

  const s = settings();
  const sent = sentToday();
  if (sent >= s.dailyCap) {
    return { action: 'daily_cap_reached', today: sent };
  }

  const nextAt = Number(getState('next_send_at', '0'));
  if (nextAt && Date.now() < nextAt) {
    return { action: 'waiting', nextSendAt: nextAt };
  }

  const due = nextDueContact();
  if (!due) return { action: 'nothing_due' };

  const ok = await sendTo(due.contact, due.step);
  const gap = randomGapMs();
  setState('next_send_at', String(Date.now() + gap));
  if (ok) checkReplyRateGuard();

  return { action: ok ? 'sent' : 'failed', contactId: due.contact.contact_id, nextGapSeconds: gap / 1000 };
}

/**
 * Antwort auf ein Ja: die Details, die in der Erstnachricht bewusst fehlten.
 *
 * Hier darf ein Link stehen - die Konversation ist eroeffnet, der Empfaenger
 * hat darum gebeten. Genau deshalb enthaelt Step 1 keinen.
 *
 * Der Text ist eine normale Variante mit Step 3, im Editor zu bearbeiten wie
 * jede andere.
 */
async function sendDetails(contact) {
  const variant = pickVariant(3);
  if (!variant) return false;

  const body = render(variant.body, contact);
  const now = Date.now();

  if (settings().dryRun) {
    logEvent('info', `DRY RUN — Details an ${contact.contact_id}: ${body.slice(0, 60)}`);
    return true;
  }

  try {
    const res = await sendSms({ contactId: contact.contact_id, message: body });
    db.prepare(
      `INSERT INTO sends (contact_id, variant_id, step, body, sent_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(contact.contact_id, variant.id, 3, body, now, res.messageId);
    markVariantSent(variant.id);
    return true;
  } catch (e) {
    db.prepare(
      `INSERT INTO sends (contact_id, variant_id, step, body, sent_at, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(contact.contact_id, variant.id, 3, body, now, String(e.message).slice(0, 500));
    logEvent('error', `Details an ${contact.contact_id} fehlgeschlagen: ${e.message}`);
    return false;
  }
}

/** Eingehende Nachricht verarbeiten — Antwort, Ja, Nein und Opt-out. */
export async function handleInbound({ contactId, text }) {
  const contact = db.prepare('SELECT * FROM contacts WHERE contact_id = ?').get(contactId);
  if (!contact) return { known: false };

  const now = Date.now();
  const clean = String(text || '').trim().toLowerCase();
  const isStop = STOP_WORDS.some((w) => clean === w || clean.startsWith(w + ' ') || clean === w + '.');

  const lastSend = db
    .prepare('SELECT * FROM sends WHERE contact_id = ? AND error IS NULL ORDER BY id DESC LIMIT 1')
    .get(contactId);

  if (lastSend && lastSend.replied === 0) {
    db.prepare('UPDATE sends SET replied = 1, replied_at = ? WHERE id = ?').run(now, lastSend.id);
    markVariantReplied(lastSend.variant_id);
  }

  if (isStop) {
    db.prepare(
      "UPDATE contacts SET status = 'opted_out', opted_out_at = ?, replied_at = COALESCE(replied_at, ?) WHERE contact_id = ?"
    ).run(now, now, contactId);
    logEvent('info', `Opt-out von ${contactId}: "${clean.slice(0, 40)}"`);
    await tag(contactId, TAG.optedOut);
    return { known: true, optedOut: true };
  }

  db.prepare("UPDATE contacts SET status = 'replied', replied_at = ? WHERE contact_id = ?").run(now, contactId);
  logEvent('info', `Antwort von ${contactId} — kein Follow-up mehr, Konversation ist offen`);
  await tag(contactId, TAG.replied);

  // Ein klares Nein: markieren und schweigen. Kein "schade", kein Nachfassen -
  // das ist der Unterschied zwischen respektiert und belaestigt.
  if (matches(clean, NO_WORDS)) {
    await tag(contactId, TAG.no);
    logEvent('info', `Nein von ${contactId}`);
    return { known: true, replied: true, answer: 'no' };
  }

  // Ein klares Ja: Tag setzen und die Details schicken. Fehlt die Step-3-
  // Variante, antwortet ein Mensch - besser als eine leere SMS.
  if (matches(clean, YES_WORDS)) {
    await tag(contactId, TAG.yes);
    const sent = await sendDetails(contact);
    logEvent('info', `Ja von ${contactId}${sent ? ' — Details verschickt' : ' — keine Step-3-Variante hinterlegt'}`);
    return { known: true, replied: true, answer: 'yes', detailsSent: sent };
  }

  return { known: true, replied: true };
}

export function stats() {
  const s = settings();
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS c FROM contacts GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

  const totalSends = db.prepare('SELECT COUNT(*) AS c FROM sends WHERE error IS NULL').get().c;
  const errors = db.prepare('SELECT COUNT(*) AS c FROM sends WHERE error IS NOT NULL').get().c;
  const { sample, rate } = replyRate();
  const today = localDay();

  return {
    paused: isPaused(),
    pauseReason: getState('pause_reason', ''),
    dryRun: s.dryRun,
    localTime: localTimeLabel(),
    insideWindow: insideSendWindow(),
    sendWindow: `${s.windowStart}:00–${s.windowEnd}:00 ${s.timezone}`,
    campaignEndsAt: s.campaignEndsAt || null,
    campaignEnded: campaignEnded(today),
    sentToday: sentToday(),
    dailyCap: s.dailyCap,
    gapSeconds: `${s.minGapSeconds}–${s.maxGapSeconds}`,
    followupAfterHours: s.followupAfterHours,
    maxMessagesWithoutReply: s.maxMessagesWithoutReply,
    totalSends,
    errors,
    replyRate: rate,
    replyRateSample: sample,
    replyRateFloor: s.replyRateFloor,
    nextSendAt: Number(getState('next_send_at', '0')) || null,
    contacts: byStatus,
  };
}
