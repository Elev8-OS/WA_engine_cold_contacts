import express from 'express';
import { config } from './config.js';
import { db, logEvent } from './db.js';
import { handleInbound, stats, pause, resume } from './campaign.js';
import { poolStats, upsertVariants } from './pool.js';

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const requireAdmin = (req, res, next) => {
    const key = req.get('x-admin-key') || req.query.key;
    if (!config.ops.adminKey || key !== config.ops.adminKey) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  // ── Inbound-Webhook aus GHL ──────────────────────────────────────────────────
  // GHL: Settings → Webhooks bzw. Workflow-Trigger "Customer Replied"
  //      → Webhook auf POST https://<app>/webhooks/ghl/inbound
  app.post('/webhooks/ghl/inbound', async (req, res) => {
    const p = req.body || {};
    const contactId = p.contactId || p.contact_id || p.contact?.id;
    const text = p.body ?? p.message ?? p.messageBody ?? '';
    const direction = (p.direction || 'inbound').toLowerCase();

    if (!contactId) return res.status(400).json({ error: 'contactId fehlt' });
    if (direction !== 'inbound') return res.json({ ignored: 'nicht inbound' });

    try {
      const result = await handleInbound({ contactId, text });
      res.json({ ok: true, ...result });
    } catch (e) {
      logEvent('error', `Webhook-Fehler: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Status ────────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      ...stats(),
      pool: poolStats(),
      recentSends: db
        .prepare(
          `SELECT s.sent_at, s.contact_id, s.variant_id, s.step, s.replied, s.error,
                  c.first_name
           FROM sends s LEFT JOIN contacts c ON c.contact_id = s.contact_id
           ORDER BY s.id DESC LIMIT 25`
        )
        .all(),
      events: db.prepare('SELECT at, level, message FROM events ORDER BY id DESC LIMIT 25').all(),
    });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ── Admin ─────────────────────────────────────────────────────────────────
  app.post('/admin/pause', requireAdmin, (req, res) => {
    pause(req.body?.reason || 'manuell über API');
    res.json({ paused: true });
  });

  app.post('/admin/resume', requireAdmin, (_req, res) => {
    resume();
    res.json({ paused: false });
  });

  app.post('/admin/pool', requireAdmin, (req, res) => {
    const list = Array.isArray(req.body) ? req.body : req.body?.variants;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Array von Varianten erwartet' });
    const n = upsertVariants(list);
    logEvent('info', `${n} Varianten über API aktualisiert`);
    res.json({ upserted: n, pool: poolStats() });
  });

  app.post('/admin/contacts', requireAdmin, (req, res) => {
    const list = Array.isArray(req.body) ? req.body : req.body?.contacts;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Array von Kontakten erwartet' });

    const stmt = db.prepare(`
      INSERT INTO contacts (contact_id, first_name, phone, created_at)
      VALUES (@contact_id, @first_name, @phone, @created_at)
      ON CONFLICT(contact_id) DO UPDATE SET
        first_name = COALESCE(excluded.first_name, contacts.first_name),
        phone = COALESCE(excluded.phone, contacts.phone)
    `);
    let n = 0;
    const run = db.transaction((items) => {
      for (const c of items) {
        const id = c.contact_id || c.contactId || c.id;
        if (!id) continue;
        stmt.run({
          contact_id: String(id),
          first_name: c.first_name || c.firstName || null,
          phone: c.phone || null,
          created_at: Date.now(),
        });
        n++;
      }
    });
    run(list);
    logEvent('info', `${n} Kontakte importiert`);
    res.json({ imported: n });
  });

  // ── Dashboard ────────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  return app;
}

function dashboardHtml() {
  const s = stats();
  const pool = poolStats();
  const sends = db
    .prepare(
      `SELECT s.sent_at, s.contact_id, s.variant_id, s.step, s.replied, s.error, c.first_name
       FROM sends s LEFT JOIN contacts c ON c.contact_id = s.contact_id
       ORDER BY s.id DESC LIMIT 20`
    )
    .all();
  const events = db.prepare('SELECT at, level, message FROM events ORDER BY id DESC LIMIT 15').all();

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const time = (ts) =>
    ts
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: config.pace.timezone,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(ts))
      : '—';
  const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);

  const statusColor = s.paused ? '#ef4444' : s.insideWindow ? '#22c55e' : '#f6bb12';
  const statusLabel = s.paused ? 'PAUSIERT' : s.insideWindow ? 'AKTIV' : 'AUSSERHALB SENDEFENSTER';
  const rateColor =
    s.replyRate === null ? '#6b7280' : s.replyRate < s.replyRateFloor ? '#ef4444' : '#22c55e';

  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS Rotator</title>
<meta http-equiv="refresh" content="20">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0b0b0c; color:#e7e7e9;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:#8b8b93; font-size:12px; margin-bottom:20px; }
  .pill { display:inline-block; padding:3px 10px; border-radius:99px; font-size:11px;
          font-weight:600; letter-spacing:.04em; background:${statusColor}22; color:${statusColor};
          border:1px solid ${statusColor}55; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:#141416; border:1px solid #24242a; border-radius:10px; padding:14px 16px; }
  .card .k { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#8b8b93; }
  .card .v { font-size:22px; font-weight:650; margin-top:4px; letter-spacing:-.02em; }
  .card .n { font-size:11px; color:#6b6b73; margin-top:2px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b8b93;
       margin:26px 0 8px; font-weight:600; }
  table { width:100%; border-collapse:collapse; background:#141416;
          border:1px solid #24242a; border-radius:10px; overflow:hidden; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em;
       color:#8b8b93; padding:9px 12px; background:#18181b; font-weight:600; }
  td { padding:9px 12px; border-top:1px solid #202027; font-size:13px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#a9a9b2; }
  .ok { color:#22c55e; } .bad { color:#ef4444; } .warn { color:#f6bb12; } .dim { color:#6b6b73; }
  .banner { background:#ef444418; border:1px solid #ef444455; color:#fca5a5;
            padding:10px 14px; border-radius:10px; margin-bottom:18px; font-size:13px; }
  .bar { height:5px; background:#24242a; border-radius:99px; overflow:hidden; margin-top:7px; }
  .bar > i { display:block; height:100%; background:#f6bb12; }
</style></head><body>

<h1>SMS Rotator <span class="pill">${statusLabel}</span></h1>
<div class="sub">Lokalzeit ${esc(s.localTime)} · Sendefenster ${esc(s.sendWindow)}${
    s.dryRun ? ' · <b class="warn">DRY RUN</b>' : ''
  }</div>

${s.paused && s.pauseReason ? `<div class="banner"><b>Pausiert:</b> ${esc(s.pauseReason)}</div>` : ''}

<div class="grid">
  <div class="card"><div class="k">Heute gesendet</div>
    <div class="v">${s.sentToday} <span class="dim" style="font-size:14px">/ ${s.dailyCap}</span></div>
    <div class="bar"><i style="width:${Math.min(100, (s.sentToday / Math.max(1, s.dailyCap)) * 100)}%"></i></div></div>
  <div class="card"><div class="k">Reply-Rate</div>
    <div class="v" style="color:${rateColor}">${pct(s.replyRate)}</div>
    <div class="n">letzte ${s.replyRateSample} Sends · Minimum ${pct(s.replyRateFloor)}</div></div>
  <div class="card"><div class="k">Sends total</div>
    <div class="v">${s.totalSends}</div>
    <div class="n">${s.errors} Fehler</div></div>
  <div class="card"><div class="k">Nächster Send</div>
    <div class="v" style="font-size:18px">${time(s.nextSendAt)}</div>
    <div class="n">Warteschlange: ${s.contacts.queued || 0}</div></div>
  <div class="card"><div class="k">Antworten</div>
    <div class="v ok">${s.contacts.replied || 0}</div>
    <div class="n">${s.contacts.opted_out || 0} Opt-outs</div></div>
</div>

<h2>Nachrichten-Pool</h2>
<table><tr><th>ID</th><th>Step</th><th>Label</th><th class="num">Gesendet</th><th class="num">Antworten</th><th class="num">Rate</th><th>Status</th></tr>
${pool
  .map(
    (v) => `<tr><td class="mono">${esc(v.id)}</td><td>${v.step}</td><td>${esc(v.label || '—')}</td>
    <td class="num">${v.sent_count}</td><td class="num">${v.reply_count}</td>
    <td class="num">${pct(v.reply_rate)}</td>
    <td>${v.active ? '<span class="ok">aktiv</span>' : '<span class="dim">aus</span>'}</td></tr>`
  )
  .join('')}
</table>

<h2>Letzte Sends</h2>
<table><tr><th>Zeit</th><th>Kontakt</th><th>Variante</th><th>Step</th><th>Antwort</th></tr>
${
  sends.length
    ? sends
        .map(
          (r) => `<tr><td class="mono">${time(r.sent_at)}</td>
      <td>${esc(r.first_name || r.contact_id)}</td>
      <td class="mono">${esc(r.variant_id)}</td><td>${r.step}</td>
      <td>${
        r.error
          ? `<span class="bad">Fehler</span>`
          : r.replied
            ? '<span class="ok">ja</span>'
            : '<span class="dim">—</span>'
      }</td></tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="dim">Noch nichts gesendet.</td></tr>'
}
</table>

<h2>Log</h2>
<table><tr><th>Zeit</th><th>Level</th><th>Meldung</th></tr>
${
  events.length
    ? events
        .map(
          (e) => `<tr><td class="mono">${time(e.at)}</td>
      <td class="${e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'dim'}">${esc(e.level)}</td>
      <td>${esc(e.message)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="dim">Kein Log.</td></tr>'
}
</table>

<div class="sub" style="margin-top:24px">Seite lädt alle 20 Sekunden neu.</div>
</body></html>`;
}
