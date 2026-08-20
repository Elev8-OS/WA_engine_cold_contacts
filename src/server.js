import express from 'express';
import { config } from './config.js';
import { db, logEvent } from './db.js';
import { handleInbound, stats, pause, resume } from './campaign.js';
import { poolStats, upsertVariants, listVariants, deleteVariant } from './pool.js';
import { settings, settingsDetail, setSettings, resetSetting } from './settings.js';
import { getBrief, generateVariants } from './generate.js';
import {
  getAudience,
  setAudience,
  availableSmartLists,
  availableTags,
  syncAudience,
  probe,
  discoverSmartLists,
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
  // GHL: Automation → Workflow mit Trigger "Customer Replied"
  //      → Action Webhook auf POST https://<app>/webhooks/ghl/inbound
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

  app.get('/api/audience/tags', requireAdmin, async (_req, res) => {
    try {
      res.json({ tags: await availableTags() });
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

  app.get('/api/audience/discover', requireAdmin, async (_req, res) => {
    try {
      res.json(await discoverSmartLists());
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

  // ── Einstellungen ─────────────────────────────────────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json({ values: settings(), detail: settingsDetail() });
  });

  app.post('/admin/settings', requireAdmin, (req, res) => {
    try {
      res.json({ values: setSettings(req.body || {}), detail: settingsDetail() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/admin/settings/reset', requireAdmin, (req, res) => {
    try {
      res.json({ values: resetSetting(req.body?.key), detail: settingsDetail() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Varianten-Generator ────────────────────────────────────────────────────
  app.get('/api/brief', requireAdmin, (_req, res) => res.json(getBrief()));

  app.post('/admin/generate', requireAdmin, async (req, res) => {
    try {
      const result = await generateVariants({
        brief: req.body?.brief,
        language: req.body?.language,
        countStep1: req.body?.countStep1,
        countStep2: req.body?.countStep2,
        existingIds: listVariants().map((v) => v.id),
      });
      res.json(result);
    } catch (e) {
      logEvent('warn', `Generator: ${e.message}`);
      res.status(400).json({ error: e.message });
    }
  });

  // ── Nachrichten-Pool ───────────────────────────────────────────────────────
  app.get('/api/pool', requireAdmin, (_req, res) => res.json({ variants: listVariants() }));

  app.delete('/admin/pool/:id', requireAdmin, (req, res) => {
    const gone = deleteVariant(req.params.id);
    if (!gone) return res.status(404).json({ error: 'Variante nicht gefunden' });
    logEvent('info', `Variante ${req.params.id} gelöscht`);
    res.json({ deleted: req.params.id });
  });

  // ── Seiten ────────────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.get('/audience', (_req, res) => {
    res.type('html').send(audiencePageHtml());
  });

  app.get('/settings', (_req, res) => {
    res.type('html').send(settingsPageHtml());
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
        overflow:auto; font-size:12px; color:#a9a9b2; margin:14px 0 0; max-height:340px;
        white-space:pre-wrap; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .dim { color:#6b6b73; } .ok { color:#22c55e; } .bad { color:#ef4444; } .warn { color:#f6bb12; }
  .kv { font-size:13px; } .kv b { color:#8b8b93; font-weight:500; }
  code { background:#0f0f11; border:1px solid #24242a; border-radius:4px; padding:1px 5px;
         font-size:12px; }
`;

function settingsPageHtml() {
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Einstellungen</title>
<style>${PAGE_CSS}
  .var { border:1px solid #24242a; border-radius:10px; padding:14px; margin-bottom:12px; background:#0f0f11; }
  .var .head { display:grid; grid-template-columns:1.2fr .5fr 1.6fr auto; gap:10px; align-items:end; }
  textarea { width:100%; min-height:88px; padding:9px 11px; background:#0f0f11; color:#e7e7e9;
             border:1px solid #2c2c34; border-radius:8px; font-size:13px; resize:vertical;
             font-family:inherit; line-height:1.5; }
  #brief { min-height:120px; }
  .meta { display:flex; gap:16px; align-items:center; font-size:11px; color:#6b6b73; margin-top:6px; }
  .chk { display:flex; align-items:center; gap:7px; font-size:12px; color:#a9a9b2; padding-bottom:9px; }
  .chk input { width:auto; }
  .grp { margin:0 0 6px; }
  .field { display:grid; grid-template-columns:1fr 150px auto; gap:12px; align-items:center;
           padding:10px 0; border-top:1px solid #202027; }
  .field:first-of-type { border-top:0; }
  .field .lbl { font-size:13px; }
  .field .hint { font-size:11px; color:#6b6b73; margin-top:2px; }
  .field .src { font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
  .del { border-color:#ef444455; background:#ef444414; color:#f87171; }
  .bar2 { position:sticky; bottom:0; background:#0b0b0cf2; padding:14px 0 4px;
          border-top:1px solid #24242a; margin-top:8px; }
</style></head><body>

<h1>Einstellungen</h1>
<div class="sub"><a href="/">&larr; Dashboard</a> &middot; <a href="/audience">Zielgruppe</a></div>

<div class="card">
  <h2>Admin-Key</h2>
  <input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="off">
  <div class="sub" style="margin:6px 0 0">Wird nur in diesem Tab gehalten. Danach „Laden" klicken.</div>
  <button id="load">Laden</button>
  <pre id="out" hidden></pre>
</div>

<div class="card">
  <h2>Kampagne beschreiben</h2>
  <div class="sub" style="margin:0 0 4px">
    Thema, Datum, Ort, Zielgruppe, was du erreichen willst. Je konkreter, desto
    brauchbarer die Varianten. Das Ergebnis landet unten als Vorschlag im Editor —
    gespeichert wird nichts, bis du auf „Nachrichten speichern" klickst.
  </div>
  <textarea id="brief" placeholder="Beispiel: CHA-08 am 12. September, 18 Uhr, im Alchemy Canggu. Zielgruppe sind Villa-Owner und Manager, die ich am Bali Villa Connect getroffen habe. Thema: echte Occupancy- und ADR-Zahlen aus 40+ Bali-Villen und was die besten 10 Prozent anders machen. 25 Plätze, gratis. Ziel: sie sollen antworten, damit ich ihnen den Anmeldelink schicken kann."></textarea>
  <div class="row" style="margin-top:12px">
    <div><label>Sprache</label><input id="lang" value="Englisch"></div>
    <div class="row">
      <div><label>Varianten Step 1</label><input id="n1" type="number" min="1" max="8" value="4"></div>
      <div><label>Step 2</label><input id="n2" type="number" min="0" max="8" value="3"></div>
    </div>
  </div>
  <button id="gen">Varianten schreiben</button>
  <span id="genstate" class="dim" style="font-size:12px; margin-left:8px"></span>
</div>

<div class="card">
  <h2>Nachrichten</h2>
  <div class="sub" style="margin:0 0 12px">
    Step 1 = Erstnachricht, Step 2 = Follow-up. <code>{{first_name}}</code> wird pro Kontakt
    eingesetzt, ohne Vornamen fällt es auf <code>there</code> zurück. Inaktive Varianten
    bleiben stehen, werden aber nicht gezogen.
  </div>
  <div id="vars"></div>
  <button id="add" class="ghost">+ Variante</button>
  <div class="bar2"><button id="saveVars">Nachrichten speichern</button></div>
</div>

<div class="card">
  <h2>Tempo, Follow-up und Bremsen</h2>
  <div class="sub" style="margin:0 0 12px">
    Gilt sofort, ohne Redeploy. <b>DB</b> heisst hier gesetzt, <b>ENV</b> heisst noch der
    Startwert aus den Railway-Variablen.
  </div>
  <div id="fields"></div>
  <div class="bar2"><button id="saveSet">Einstellungen speichern</button></div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const out = $('out');
const show = (v) => { out.hidden = false; out.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
const key = () => $('key').value.trim();
const need = () => { if (!key()) { show('Bitte zuerst den ADMIN_KEY eintragen.'); return false; } return true; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-admin-key': key(), 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({ error: 'keine JSON-Antwort' }));
  if (!res.ok) throw new Error(body.error || JSON.stringify(body));
  return body;
}

let newCount = 0;

function varRow(v) {
  const d = document.createElement('div');
  d.className = 'var';
  d.dataset.original = v.id;
  d.innerHTML =
    '<div class="head">' +
      '<div><label>ID</label><input class="v-id" value="' + esc(v.id) + '"></div>' +
      '<div><label>Step</label><input class="v-step" type="number" min="1" max="5" value="' + v.step + '"></div>' +
      '<div><label>Label</label><input class="v-label" value="' + esc(v.label || '') + '"></div>' +
      '<div class="chk"><input class="v-active" type="checkbox" ' + (v.active ? 'checked' : '') + '> aktiv</div>' +
    '</div>' +
    '<label>Text</label>' +
    '<textarea class="v-body">' + esc(v.body || '') + '</textarea>' +
    '<div class="meta">' +
      '<span class="cnt"></span>' +
      '<span>gesendet ' + (v.sent_count || 0) + ' · Antworten ' + (v.reply_count || 0) + '</span>' +
      (v.generated ? '<span class="warn">neu generiert</span>' : '') +
      '<span style="flex:1"></span>' +
      '<button class="del" style="margin:0">Löschen</button>' +
    '</div>';

  const body = d.querySelector('.v-body');
  const cnt = d.querySelector('.cnt');
  const upd = () => {
    const n = body.value.length;
    const segs = Math.max(1, Math.ceil(n / 160));
    cnt.textContent = n + ' Zeichen · ' + segs + ' SMS-Segment' + (segs > 1 ? 'e' : '');
    cnt.style.color = segs > 2 ? '#f6bb12' : '#6b6b73';
  };
  body.oninput = upd; upd();

  d.querySelector('.del').onclick = async () => {
    const id = d.dataset.original;
    if (!id.startsWith('__new') && !v.generated) {
      if (!need()) return;
      try { await call('/admin/pool/' + encodeURIComponent(id), { method: 'DELETE' }); }
      catch (e) { return show('Fehler: ' + e.message); }
    }
    d.remove();
    show('Variante entfernt.');
  };
  return d;
}

async function loadAll() {
  if (!need()) return;
  show('lade …');
  try {
    const [{ variants }, { detail }, brief] = await Promise.all([
      call('/api/pool'), call('/api/settings'), call('/api/brief'),
    ]);

    if (brief.brief) $('brief').value = brief.brief;
    if (brief.language) $('lang').value = brief.language;
    $('n1').value = brief.countStep1;
    $('n2').value = brief.countStep2;
    $('genstate').textContent = !brief.enabled
      ? 'Generator aus — ANTHROPIC_API_KEY in Railway setzen.'
      : brief.lastGeneratedAt
        ? 'Zuletzt generiert mit ' + brief.lastModel
        : '';
    $('gen').disabled = !brief.enabled;

    const box = $('vars');
    box.innerHTML = '';
    variants.forEach(v => box.appendChild(varRow(v)));

    const fields = $('fields');
    fields.innerHTML = '';
    let group = null;
    for (const f of detail) {
      if (f.group !== group) {
        group = f.group;
        const h = document.createElement('div');
        h.className = 'grp';
        h.innerHTML = '<h2 style="margin:16px 0 2px">' + esc(group) + '</h2>';
        fields.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'field';
      const input = f.type === 'bool'
        ? '<input type="checkbox" class="s-val" ' + (f.value ? 'checked' : '') + '>'
        : '<input class="s-val" value="' + esc(f.value) + '"' +
          (f.type === 'int' || f.type === 'float' ? ' type="number" step="' + (f.type === 'int' ? '1' : '0.01') + '"' : '') +
          (f.min !== undefined ? ' min="' + f.min + '"' : '') +
          (f.max !== undefined ? ' max="' + f.max + '"' : '') + '>';
      row.innerHTML =
        '<div><div class="lbl">' + esc(f.label) + '</div>' +
        (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '</div>' +
        '<div>' + input + '</div>' +
        '<div><span class="src ' + (f.source === 'db' ? 'ok' : 'dim') + '">' + f.source.toUpperCase() + '</span>' +
        (f.source === 'db' ? ' <a href="#" class="rst" style="font-size:11px">zurücksetzen</a>' : '') + '</div>';
      row.dataset.key = f.key;
      row.dataset.type = f.type;
      const rst = row.querySelector('.rst');
      if (rst) rst.onclick = async (e) => {
        e.preventDefault();
        try { await call('/admin/settings/reset', { method: 'POST', body: JSON.stringify({ key: f.key }) }); await loadAll(); show('Auf Startwert zurückgesetzt: ' + f.key); }
        catch (err) { show('Fehler: ' + err.message); }
      };
      fields.appendChild(row);
    }
    show(variants.length + ' Varianten und ' + detail.length + ' Einstellungen geladen.');
  } catch (e) { show('Fehler: ' + e.message); }
}

$('load').onclick = loadAll;

$('add').onclick = () => {
  newCount++;
  $('vars').appendChild(varRow({ id: '__new' + newCount, step: 1, label: '', body: '', active: true }));
};

$('gen').onclick = async () => {
  if (!need()) return;
  const btn = $('gen');
  btn.disabled = true;
  const before = btn.textContent;
  btn.textContent = 'schreibt …';
  show('Das Modell schreibt die Varianten. Dauert 15 bis 40 Sekunden.');
  try {
    const r = await call('/admin/generate', {
      method: 'POST',
      body: JSON.stringify({
        brief: $('brief').value,
        language: $('lang').value.trim() || 'Englisch',
        countStep1: parseInt($('n1').value, 10),
        countStep2: parseInt($('n2').value, 10),
      }),
    });
    const box = $('vars');
    for (const v of r.variants) box.appendChild(varRow(v));
    $('genstate').textContent = 'generiert mit ' + r.model;
    let msg = r.variants.length + ' Varianten unten eingefügt — noch NICHT gespeichert.\n\n';
    msg += 'Lies jeden Text, bevor du speicherst. Alte Varianten stehen weiter da; die, die du nicht willst, mit „Löschen" wegnehmen.';
    if (r.notes) msg += '\n\nHinweis vom Modell: ' + r.notes;
    show(msg);
    box.lastChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    show('Fehler: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = before;
  }
};

$('saveVars').onclick = async () => {
  if (!need()) return;
  const rows = [...document.querySelectorAll('.var')];
  const list = [];
  for (const d of rows) {
    const id = d.querySelector('.v-id').value.trim();
    const bodyText = d.querySelector('.v-body').value.trim();
    if (!id || id.startsWith('__new')) { show('Jede Variante braucht eine eigene ID (z. B. s1-invite).'); return; }
    if (!bodyText) { show('Variante ' + id + ' hat keinen Text.'); return; }
    list.push({
      id,
      step: parseInt(d.querySelector('.v-step').value, 10) || 1,
      label: d.querySelector('.v-label').value.trim(),
      body: bodyText,
      active: d.querySelector('.v-active').checked,
    });
  }
  const ids = list.map(v => v.id);
  const dupe = ids.find((v, i) => ids.indexOf(v) !== i);
  if (dupe) { show('ID doppelt: ' + dupe); return; }
  show('speichere …');
  try { const r = await call('/admin/pool', { method: 'POST', body: JSON.stringify(list) }); await loadAll(); show(r.upserted + ' Varianten gespeichert.'); }
  catch (e) { show('Fehler: ' + e.message); }
};

$('saveSet').onclick = async () => {
  if (!need()) return;
  const patch = {};
  for (const row of document.querySelectorAll('.field')) {
    const el = row.querySelector('.s-val');
    if (!el) continue;
    patch[row.dataset.key] = row.dataset.type === 'bool' ? el.checked : el.value;
  }
  show('speichere …');
  try { await call('/admin/settings', { method: 'POST', body: JSON.stringify(patch) }); await loadAll(); show('Einstellungen gespeichert — gilt ab sofort.'); }
  catch (e) { show('Fehler: ' + e.message); }
};
</script>
</body></html>`;
}

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
<div class="sub"><a href="/">&larr; Dashboard</a> &middot; <a href="/settings">Einstellungen</a></div>

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
        <option value="tag"${a.type === 'tag' ? ' selected' : ''}>Tag (funktioniert)</option>
        <option value="smartlist"${a.type === 'smartlist' ? ' selected' : ''}>Smart List (nur falls API sie hergibt)</option>
        <option value="manual"${a.type === 'manual' ? ' selected' : ''}>Manuell (CSV / API)</option>
      </select>
    </div>
    <div>
      <label>Smart List</label>
      <select id="smartlist"><option value="">— Liste laden —</option></select>
    </div>
  </div>
  <div class="row">
    <div>
      <label>Tag aus GHL</label>
      <select id="tagsel"><option value="">— Tags laden —</option></select>
    </div>
    <div>
      <label>oder Tag-Name tippen</label>
      <input id="tag" placeholder="z. B. cha08-invite" value="${a.type === 'tag' ? esc(a.id) : ''}">
    </div>
  </div>

  <button id="loadTags" class="ghost">Tags laden</button>
  <button id="load" class="ghost">Smart Lists laden</button>
  <button id="save">Speichern &amp; synchronisieren</button>
  <button id="sync" class="ghost">Nur synchronisieren</button>
  <button id="probe" class="ghost">API prüfen</button>
  <button id="discover" class="ghost">Smart-List-Endpoints scannen</button>
  <pre id="out" hidden></pre>
</div>

<div class="card">
  <h2>Warum Tag statt Smart List</h2>
  <div class="sub" style="margin:0">
    HighLevel hat für Smart Lists keinen öffentlichen API-Endpoint — „API prüfen"
    zeigt dir das für deine Location, „Smart-List-Endpoints scannen" probiert alle
    plausiblen Pfade durch und zeigt jeden Statuscode.<br><br>
    Der Weg, der sauber funktioniert: in GHL die Smart List öffnen, alle auswählen,
    Bulk Action <b>Add Tag</b>, z. B. <code>cha08-invite</code>. Dann hier den Tag wählen.
    Damit die Liste dynamisch bleibt, statt einmalig zu taggen: in GHL einen Workflow mit
    denselben Bedingungen wie die Smart List anlegen, Action <b>Add Tag</b> — dann wird
    jeder neue Kontakt automatisch getaggt und landet beim nächsten Sync in der Warteschlange.
  </div>
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

$('loadTags').onclick = async () => {
  if (!need()) return;
  show('lade Tags …');
  try {
    const { tags } = await call('/api/audience/tags');
    const sel = $('tagsel');
    sel.innerHTML = '<option value="">— auswählen —</option>';
    for (const t of tags) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      sel.appendChild(o);
    }
    sel.onchange = () => { if (sel.value) $('tag').value = sel.value; };
    show(tags.length ? tags.length + ' Tags geladen. Auswahl füllt das Feld rechts.' : 'Keine Tags in dieser Location gefunden.');
  } catch (e) { show('Fehler: ' + e.message); }
};

$('discover').onclick = async () => {
  if (!need()) return;
  show('scanne mögliche Smart-List-Endpoints … das dauert ein paar Sekunden.');
  try { show(await call('/api/audience/discover')); }
  catch (e) { show('Fehler: ' + e.message); }
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
          timeZone: settings().timezone,
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
  a { color:#f6bb12; }
</style></head><body>

<h1>SMS Rotator <span class="pill">${statusLabel}</span></h1>
<div class="sub">Lokalzeit ${esc(s.localTime)} · Sendefenster ${esc(s.sendWindow)}${
    s.dryRun ? ' · <b class="warn">DRY RUN</b>' : ''
  } &middot; Abstand ${esc(s.gapSeconds)} s${
    s.campaignEndsAt ? ` &middot; Ende ${esc(s.campaignEndsAt)}` : ''
  }<br><a href="/audience">Zielgruppe</a> &middot; <a href="/settings">Einstellungen</a></div>

${
  s.campaignEnded
    ? `<div class="banner"><b>Kampagne beendet:</b> Enddatum ${esc(s.campaignEndsAt)} ist erreicht. Es wird nichts mehr gesendet.</div>`
    : ''
}
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
