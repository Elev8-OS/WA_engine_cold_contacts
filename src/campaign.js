import { config } from './config.js';
import { db, getState, setState, logEvent } from './db.js';
import { sendSms, addTags } from './ghl.js';
import { pickVariant, markVariantSent, markVariantReplied, render } from './pool.js';
import { insideSendWindow, localDay, localTimeLabel, randomGapMs, HOUR_MS } from './time.js';

const STOP_WORDS = [
  'stop', 'out', 'unsubscribe', 'remove', 'no thanks', 'not interested',
  'berhenti', 'abmelden',
];

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
    .all(config.guard.replyRateWindow);
  if (rows.length === 0) return { sample: 0, rate: null };
  const replies = rows.filter((r) => r.replied === 1).length;
  return { sample: rows.length, rate: replies / rows.length };
}

function checkReplyRateGuard() {
  const { sample, rate } = replyRate();
  if (sample < config.guard.replyRateMinSample) return;
  if (rate !== null && rate < config.guard.replyRateFloor) {
    pause(
      `Reply-Rate ${(rate * 100).toFixed(0)}% liegt unter dem Minimum von ` +
        `${(config.guard.replyRateFloor * 100).toFixed(0)}% (letzte ${sample} Sends)`
    );
  }
}

/**
 * Nächster fälliger Kontakt.
 * Step 1 = Erstnachricht. Step 2+ = Follow-up, nur ohne Antwort und nach Wartezeit.
 */
function nextDueContact() {
  const firstTouch = db
    .prepare(
      `SELECT * FROM contacts
       WHERE status = 'queued' AND step = 0 AND opted_out_at IS NULL AND replied_at IS NULL
       ORDER BY created_at ASC LIMIT 1`
    )
    .get();
  if (firstTouch) return { contact: firstTouch, step: 1 };

  if (config.pace.followupAfterHours <= 0) return null;

  const cutoff = Date.now() - config.pace.followupAfterHours * HOUR_MS;
  const followUp = db
    .prepare(
      `SELECT * FROM contacts
       WHERE status = 'sent' AND replied_at IS NULL AND opted_out_at IS NULL
         AND step >= 1 AND step < ? AND last_sent_at IS NOT NULL AND last_sent_at <= ?
       ORDER BY last_sent_at ASC LIMIT 1`
    )
    .get(config.pace.maxMessagesWithoutReply, cutoff);
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

  if (config.ops.dryRun) {
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

  if (!insideSendWindow()) {
    return { action: 'outside_window', localTime: localTimeLabel() };
  }

  const today = sentToday();
  if (today >= config.pace.dailyCap) {
    return { action: 'daily_cap_reached', today };
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

/** Eingehende Nachricht verarbeiten — Antwort und Opt-out. */
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
    if (!config.ops.dryRun) {
      try {
        await addTags(contactId, ['cha08-opted-out']);
      } catch (e) {
        logEvent('warn', `Tag cha08-opted-out fehlgeschlagen: ${e.message}`);
      }
    }
    return { known: true, optedOut: true };
  }

  db.prepare("UPDATE contacts SET status = 'replied', replied_at = ? WHERE contact_id = ?").run(now, contactId);
  logEvent('info', `Antwort von ${contactId} — kein Follow-up mehr, Konversation ist offen`);
  if (!config.ops.dryRun) {
    try {
      await addTags(contactId, ['cha08-replied']);
    } catch (e) {
      logEvent('warn', `Tag cha08-replied fehlgeschlagen: ${e.message}`);
    }
  }
  return { known: true, replied: true };
}

export function stats() {
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS c FROM contacts GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

  const totalSends = db.prepare('SELECT COUNT(*) AS c FROM sends WHERE error IS NULL').get().c;
  const errors = db.prepare('SELECT COUNT(*) AS c FROM sends WHERE error IS NOT NULL').get().c;
  const { sample, rate } = replyRate();

  return {
    paused: isPaused(),
    pauseReason: getState('pause_reason', ''),
    dryRun: config.ops.dryRun,
    localTime: localTimeLabel(),
    insideWindow: insideSendWindow(),
    sendWindow: `${config.pace.windowStart}:00–${config.pace.windowEnd}:00 ${config.pace.timezone}`,
    sentToday: sentToday(),
    dailyCap: config.pace.dailyCap,
    totalSends,
    errors,
    replyRate: rate,
    replyRateSample: sample,
    replyRateFloor: config.guard.replyRateFloor,
    nextSendAt: Number(getState('next_send_at', '0')) || null,
    contacts: byStatus,
  };
}
