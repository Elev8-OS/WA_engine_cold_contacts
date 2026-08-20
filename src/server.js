import express from 'express';
import { config } from './config.js';
import { db, logEvent } from './db.js';
import { handleInbound, stats, pause, resume } from './campaign.js';
import { poolStats, upsertVariants } from './pool.js';
import {
  getAudience,
  setAudience,
  availableSmartLists,
  syncAudience,
  probe,
} from './audience.js';

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
      audience: getAudience(),
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

  // ── Zielgruppe ───────────────────────────────────────────────────────────
  app.get('/api/audience', (_req, res) => res.json(getAudience()));

  app.get('/api/audience/smartlists', requireAdmin, async (_req, res) => {
    try {
      res.json({ smartLists: await availableSmartLists() });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get('/api/audience/probe', requireAdmin, async (_req, res) => {
    try {
      res.json(await probe());
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/admin/audience', requireAdmin, async (req, res) => {
    try {
      const audience = setAudience({
        type: req.body?.type,
        id: req.body?.id,
        label: req.body?.label,
      });
      const sync = req.body?.sync === false ? null : await syncAudience();
      res.json({ audience, sync });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/admin/sync', requireAdmin, async (req, res) => {
    try {
      res.json(await syncAudience({ prune: req.body?.prune !== false }));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ── Dashboard ────────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.get('/audience', (_req, res) => {
    res.type('html').send(audiencePageHtml());
  });

  return app;
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0b0b0c; color:#e7e7e9;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  a { color:#f6bb12; }
  h1 { font-size:20px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:#8b8b93; font-size:12px; margin-bottom:20px; }
  .card { background:#141416; border:1px solid #24242a; border-radius:10px; padding:16px; margin-bottom:14px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b8b93;
       margin:0 0 10px; font-weight:600; }
  label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em;
          color:#8b8b93; margin:12px 0 5px; }
  input, select { width:100%; padding:9px 11px; background:#0f0f11; color:#e7e7e9;
                  border:1px solid #2c2c34; border-radius:8px; font-size:13px; }
  button { padding:9px 16px; border-radius:8px; border:1px solid #f6bb1255;
           background:#f6bb1218; color:#f6bb12; font-size:13px; font-weight:600;
           cursor:pointer; margin:14px 8px 0 0; }
  button.ghost { border-color:#2c2c34; background:#18181b; color:#a9a9b2; }
  button:disabled { opacity:.45; cursor:default; }
  pre { background:#0f0f11; border:1px solid #24242a; border-radius:8px; padding:12px;
        overflow:auto; font-size:12px; color:#a9a9b2; margin:14px 0 0; max-height:340px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .dim { color:#6b6b73; } .ok { color:#22c55e; } .bad { color:#ef4444; } .warn { color:#f6bb12; }
  .kv { font-size:13px; } .kv b { color:#8b8b93; font-weight:500; }
`;

function audiencePageHtml() {
  const a = getAudience();
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zielgruppe</title>
<style>${PAGE_CSS}</style></head><body>

<h1>Zielgruppe</h1>
<div class="sub"><a href="/">&larr; zurück zum Dashboard</a></div>

<div class="card">
  <h2>Aktuell</h2>
  <div class="kv"><b>Quelle:</b> ${esc(a.type)}${a.id ? ` &middot; ${esc(a.label || a.id)}` : ''}</div>
  <div class="kv"><b>Letzter Sync:</b> ${a.lastSyncResult ? esc(a.lastSyncResult) : '<span class="dim">nie</span>'}</div>
</div>

<div class="card">
  <h2>Admin-Key</h2>
  <input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="off">
  <div class="sub" style="margin:6px 0 0">Wird nur in diesem Tab gehalten, nicht gespeichert.</div>
</div>

<div class="card">
  <h2>Quelle wählen</h2>
  <div class="row">
    <div>
      <label>Typ</label>
      <select id="type">
        <option value="smartlist"${a.type === 'smartlist' ? ' selected' : ''}>Smart List</option>
        <option value="tag"${a.type === 'tag' ? ' selected' : ''}>Tag</option>
        <option value="manual"${a.type === 'manual' ? ' selected' : ''}>Manuell (CSV / API)</option>
      </select>
    </div>
    <div>
      <label>Smart List</label>
      <select id="smartlist"><option value="">— Liste laden —</option></select>
    </div>
  </div>
  <label>Tag-Name (nur bei Typ „Tag")</label>
  <input id="tag" placeholder="z. B. cha08-invite" value="${a.type === 'tag' ? esc(a.id) : ''}">

  <button id="load" class="ghost">Smart Lists laden</button>
  <button id="save">Speichern &amp; synchronisieren</button>
  <button id="sync" class="ghost">Nur synchronisieren</button>
  <button id="probe" class="ghost">API prüfen</button>
  <pre id="out" hidden></pre>
</div>

<script>
const $ = (id) => document.getElementById(id);
const out = $('out');
const show = (v) => { out.hidden = false; out.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
const key = () => $('key').value.trim();
const need = () => { if (!key()) { show('Bitte zuerst den ADMIN_KEY eintragen.'); return false; } return true; };

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-admin-key': key(), 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({ error: 'keine JSON-Antwort' }));
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

$('load').onclick = async () => {
  if (!need()) return;
  show('lade …');
  try {
    const { smartLists } = await call('/api/audience/smartlists');
    const sel = $('smartlist');
    sel.innerHTML = '<option value="">— auswählen —</option>';
    for (const l of smartLists) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.name + (l.count != null ? ' (' + l.count + ')' : '');
      o.dataset.name = l.name;
      sel.appendChild(o);
    }
    show(smartLists.length ? smartLists.length + ' Smart Lists geladen.' : 'Keine Smart Lists gefunden — "API prüfen" klicken.');
  } catch (e) { show('Fehler: ' + e.message); }
};

$('save').onclick = async () => {
  if (!need()) return;
  const type = $('type').value;
  const sel = $('smartlist');
  const id = type === 'smartlist' ? sel.value : type === 'tag' ? $('tag').value.trim() : '';
  const label = type === 'smartlist' ? (sel.selectedOptions[0]?.dataset.name || '') : id;
  show('speichere und synchronisiere …');
  try { show(await call('/admin/audience', { method: 'POST', body: JSON.stringify({ type, id, label }) })); }
  catch (e) { show('Fehler: ' + e.message); }
};

$('sync').onclick = async () => {
  if (!need()) return;
  show('synchronisiere …');
  try { show(await call('/admin/sync', { method: 'POST', body: '{}' })); }
  catch (e) { show('Fehler: ' + e.message); }
};

$('probe').onclick = async () => {
  if (!need()) return;
  show('prüfe API-Wege …');
  try { show(await call('/api/audience/probe')); }
  catch (e) { show('Fehler: ' + e.message); }
};
</script>
</body></html>`;
}

function dashboardHtml() {
  const s = stats();
  const a = getAudience();
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
  } &middot; <a href="/audience" style="color:#f6bb12">Zielgruppe</a></div>

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
  <div class="card"><div class="k">Zielgruppe</div>
    <div class="v" style="font-size:15px">${esc(a.label || a.id || a.type)}</div>
    <div class="n">${a.type}${a.lastSyncAt ? ` · Sync ${time(a.lastSyncAt)}` : ' · noch nie gesynct'}</div></div>
</div>

${
  a.lastSyncResult
    ? `<div class="sub" style="margin:-12px 0 20px">Letzter Sync: ${esc(a.lastSyncResult)}</div>`
    : ''
}

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
