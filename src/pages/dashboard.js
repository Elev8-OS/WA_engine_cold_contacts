import { stats } from '../campaign.js';
import { poolStats } from '../pool.js';
import { settings } from '../settings.js';
import { getAudience } from '../audience.js';
import { listSends, listEvents } from '../history.js';
import { loginCard, LOGIN_JS, LOGOUT_JS, LOGOUT_LINK } from './auth-ui.js';

const PAGE = 25;

export function dashboardHtml({ loggedIn = false } = {}) {
  const s = stats();
  const a = getAudience();
  const pool = poolStats();
  const sendPage = listSends({ limit: PAGE });
  const eventPage = listEvents({ limit: PAGE });
  const sends = sendPage.rows;
  const events = eventPage.rows;

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
  .ctrl { background:#141416; border:1px solid #24242a; border-radius:10px;
          padding:14px 16px; margin-bottom:16px; display:flex; gap:12px;
          align-items:center; flex-wrap:wrap; }
  .ctrl input { flex:1 1 220px; min-width:180px; padding:9px 11px; background:#0f0f11;
                color:#e7e7e9; border:1px solid #2c2c34; border-radius:8px; font-size:13px; }
  .ctrl button { padding:10px 18px; border-radius:8px; font-size:13px; font-weight:650;
                 cursor:pointer; border:1px solid; background:transparent; }
  #go { border-color:#22c55e66; background:#22c55e18; color:#4ade80; }
  #stop { border-color:#ef444466; background:#ef444418; color:#f87171; }
  .ghost2 { border-color:#2c2c34; background:#18181b; color:#a9a9b2; }
  .ctrl button:disabled { opacity:.4; cursor:default; }
  #ctrlmsg { font-size:12px; color:#8b8b93; flex:1 1 100%; margin:0; }
  #logincard { background:#141416; border:1px solid #24242a; border-radius:10px;
               padding:16px; margin-bottom:16px; }
  #logincard h2 { margin:0 0 6px; }
  #logincard .sub { margin:0 0 10px; }
  #logincard input { width:100%; max-width:340px; padding:9px 11px; background:#0f0f11;
                     color:#e7e7e9; border:1px solid #2c2c34; border-radius:8px; font-size:13px; }
  #logincard button { padding:9px 16px; border-radius:8px; border:1px solid #f6bb1255;
                      background:#f6bb1218; color:#f6bb12; font-size:13px; font-weight:600;
                      cursor:pointer; margin-left:8px; }
  .pager { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0 0;
           font-size:12px; color:#8b8b93; }
  .pager select, .pager input { padding:6px 9px; background:#0f0f11; color:#e7e7e9;
           border:1px solid #2c2c34; border-radius:7px; font-size:12px; }
  .pager input { width:150px; }
  .pager button { padding:6px 12px; border-radius:7px; border:1px solid #2c2c34;
           background:#18181b; color:#a9a9b2; font-size:12px; cursor:pointer; }
  .pager button:disabled { opacity:.35; cursor:default; }
  .pager .count { margin-left:auto; font-variant-numeric:tabular-nums; }
  .pager .sp { color:#3a3a42; }
</style></head><body>

<h1>SMS Rotator <span class="pill">${statusLabel}</span></h1>
<div class="sub">Lokalzeit ${esc(s.localTime)} · Sendefenster ${esc(s.sendWindow)}${
    s.dryRun ? ' · <b class="warn">DRY RUN</b>' : ''
  } &middot; Abstand ${esc(s.gapSeconds)} s${
    s.campaignEndsAt ? ` &middot; Ende ${esc(s.campaignEndsAt)}` : ''
  }<br><a href="/audience">Zielgruppe</a> &middot; <a href="/settings">Einstellungen</a>${loggedIn ? LOGOUT_LINK : ''}</div>

${
  s.campaignEnded
    ? `<div class="banner"><b>Kampagne beendet:</b> Enddatum ${esc(s.campaignEndsAt)} ist erreicht. Es wird nichts mehr gesendet.</div>`
    : ''
}
${s.paused && s.pauseReason ? `<div class="banner"><b>Pausiert:</b> ${esc(s.pauseReason)}</div>` : ''}

${loggedIn ? '' : loginCard()}
${loggedIn ? `<div class="ctrl">
  <button id="go"${s.paused ? '' : ' disabled'}>${
    s.dryRun ? 'Freigeben (Testmodus)' : 'Scharf schalten'
  }</button>
  <button id="stop"${s.paused ? ' disabled' : ''}>Notbremse</button>${
    s.stuck ? `<button id="requeue" class="ghost2">${s.stuck} hängende zurückholen</button>` : ''
  }
  <p id="ctrlmsg">${
    s.paused
      ? s.dryRun
        ? 'Testmodus ist an — Freigeben protokolliert nur, es geht nichts raus.'
        : 'Scharf: nach der Freigabe geht innerhalb von 30 Sekunden die erste echte SMS raus.'
      : s.dryRun
        ? 'Läuft im Testmodus. Es geht nichts raus.'
        : 'Läuft scharf. Es gehen echte SMS raus.'
  }</p>
</div>` : ''}

<div class="grid">
  <div class="card"><div class="k">Heute gesendet</div>
    <div class="v">${s.sentToday} <span class="dim" style="font-size:14px">/ ${s.dailyCap}</span></div>
    <div class="bar"><i style="width:${Math.min(100, (s.sentToday / Math.max(1, s.dailyCap)) * 100)}%"></i></div></div>
  <div class="card"><div class="k">Reply-Rate</div>
    <div class="v" style="color:${rateColor}">${pct(s.replyRate)}</div>
    <div class="n">${s.replyRateSample} reife Sends (Bremse ab ${s.replyRateMinSample}) · Minimum ${pct(s.replyRateFloor)}${
      s.maturing ? `<br>${s.maturing} reifen noch (${s.replyRateMaturityHours} h)` : ''
    }</div></div>
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

<h2>Sends</h2>
<table><thead><tr><th>Zeit</th><th>Kontakt</th><th>Variante</th><th>Step</th><th>Antwort</th></tr></thead>
<tbody id="sendrows">
${
  sends.length
    ? sends
        .map(
          (r) => `<tr><td class="mono">${time(r.sent_at)}</td>
      <td>${esc(r.first_name || r.contact_id)}</td>
      <td class="mono" title="${esc(r.body)}">${esc(r.variant_id)}</td><td>${r.step}</td>
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
</tbody></table>
${
  loggedIn
    ? `<div class="pager" id="sendpager">
  <select data-role="filter">
    <option value="all">alle</option>
    <option value="replied">nur mit Antwort</option>
    <option value="open">ohne Antwort</option>
    <option value="errors">nur Fehler</option>
  </select>
  <input data-role="q" placeholder="Name, ID, Variante">
  <select data-role="size"><option>25</option><option>50</option><option>100</option><option>250</option></select>
  <button data-role="first" disabled>&laquo;</button>
  <button data-role="prev" disabled>zurück</button>
  <button data-role="next">weiter</button>
  <span class="count" data-role="count">1–${sends.length} von ${sendPage.total}</span>
</div>`
    : `<div class="sub" style="margin-top:8px">${sendPage.total} Sends insgesamt — zum Blättern anmelden.</div>`
}

<h2>Log</h2>
<table><thead><tr><th>Zeit</th><th>Level</th><th>Meldung</th></tr></thead>
<tbody id="logrows">
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
</tbody></table>
${
  loggedIn
    ? `<div class="pager" id="logpager">
  <select data-role="filter">
    <option value="all">alle Level</option>
    <option value="info">info</option>
    <option value="warn">warn</option>
    <option value="error">error</option>
  </select>
  <input data-role="q" placeholder="Meldung suchen">
  <select data-role="size"><option>25</option><option>50</option><option>100</option><option>250</option></select>
  <button data-role="first" disabled>&laquo;</button>
  <button data-role="prev" disabled>zurück</button>
  <button data-role="next">weiter</button>
  <span class="count" data-role="count">1–${events.length} von ${eventPage.total}</span>
</div>`
    : `<div class="sub" style="margin-top:8px">${eventPage.total} Log-Zeilen — zum Blättern anmelden.</div>`
}

<div class="sub" style="margin-top:24px">Seite lädt alle 20 Sekunden neu — ausser beim Blättern, Filtern oder Suchen.</div>

<script>
${loggedIn ? '' : LOGIN_JS}
${loggedIn ? LOGOUT_JS : ''}
${loggedIn ? `
const el = (id) => document.getElementById(id);
const msg = el('ctrlmsg');
const scharf = ${s.dryRun ? 'false' : 'true'};

// Zwei-Klick-Bestätigung statt Dialog: der erste Klick bewaffnet, der zweite feuert.
// Nach fünf Sekunden ohne zweiten Klick entschärft sich der Button wieder.
function arm(btn, label, run) {
  let armed = false;
  let timer = null;
  const reset = () => { armed = false; btn.textContent = label; clearTimeout(timer); };
  btn.onclick = async () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Wirklich? Nochmal klicken';
      timer = setTimeout(reset, 5000);
      return;
    }
    reset();
    btn.disabled = true;
    try { await run(); } finally { btn.disabled = false; }
  };
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
  return out;
}

arm(el('go'), el('go').textContent, async () => {
  msg.textContent = 'gebe frei …';
  try {
    await post('/admin/resume');
    msg.textContent = scharf
      ? 'Freigegeben. Die erste echte SMS geht innerhalb von 30 Sekunden raus.'
      : 'Freigegeben im Testmodus. Es geht nichts raus.';
    setTimeout(() => location.reload(), 1200);
  } catch (e) { msg.textContent = 'Fehler: ' + e.message; }
});

arm(el('stop'), 'Notbremse', async () => {
  msg.textContent = 'stoppe …';
  try {
    await post('/admin/pause', { reason: 'Notbremse im Dashboard' });
    msg.textContent = 'Gestoppt. Es geht nichts mehr raus.';
    setTimeout(() => location.reload(), 1200);
  } catch (e) { msg.textContent = 'Fehler: ' + e.message; }
});

const rq = el('requeue');
if (rq) rq.onclick = async () => {
  rq.disabled = true;
  msg.textContent = 'hole zurück …';
  try {
    const r = await post('/admin/requeue');
    msg.textContent = r.found + ' gefunden: ' + r.queued + ' zurück in die Warteschlange, '
      + r.restored + ' auf den letzten erfolgreichen Step (kein Doppelversand).';
    setTimeout(() => location.reload(), 2500);
  } catch (e) {
    msg.textContent = 'Fehler: ' + e.message;
    rq.disabled = false;
  }
};

// ── Blättern in Sends und Log ─────────────────────────────────────────
// Der Server rendert die erste Seite, ab hier holt die Seite selbst nach. So
// bleibt das Dashboard ohne JS lesbar und mit JS vollständig durchblätterbar.
const TZ = '${settings().timezone}';
const stamp = new Intl.DateTimeFormat('en-GB',
  { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const t = (ts) => (ts ? stamp.format(new Date(ts)) : '—');
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pager(opts) {
  const root = el(opts.id);
  if (!root) return null;
  const body = el(opts.rows);
  const part = (role) => root.querySelector('[data-role="' + role + '"]');
  const state = { offset: 0, limit: 25, filter: 'all', q: '' };
  let debounce = null;

  // Beim Blättern, Filtern oder Suchen darf der Auto-Reload nicht dazwischenfahren.
  const busy = () => state.offset > 0 || state.filter !== 'all' || state.q !== '';

  async function load() {
    const url = opts.url + '?limit=' + state.limit + '&offset=' + state.offset
      + '&' + opts.filterParam + '=' + encodeURIComponent(state.filter)
      + '&q=' + encodeURIComponent(state.q);
    let d;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      d = await res.json();
    } catch (e) {
      part('count').textContent = 'Fehler: ' + e.message;
      return;
    }
    body.innerHTML = d.rows.length ? d.rows.map(opts.row).join('') : opts.empty;
    const from = d.total === 0 ? 0 : d.offset + 1;
    const to = Math.min(d.total, d.offset + d.rows.length);
    part('count').textContent = from + '–' + to + ' von ' + d.total;
    part('first').disabled = d.offset === 0;
    part('prev').disabled = d.offset === 0;
    part('next').disabled = d.offset + d.rows.length >= d.total;
  }

  part('next').onclick = () => { state.offset += state.limit; load(); };
  part('prev').onclick = () => { state.offset = Math.max(0, state.offset - state.limit); load(); };
  part('first').onclick = () => { state.offset = 0; load(); };
  part('size').onchange = () => {
    state.limit = parseInt(part('size').value, 10) || 25;
    state.offset = 0;
    load();
  };
  part('filter').onchange = () => { state.filter = part('filter').value; state.offset = 0; load(); };
  part('q').oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = part('q').value.trim(); state.offset = 0; load(); }, 350);
  };
  return { busy: busy, load: load };
}

const sendPager = pager({
  id: 'sendpager', rows: 'sendrows', url: '/api/sends', filterParam: 'filter',
  empty: '<tr><td colspan="5" class="dim">Nichts gefunden.</td></tr>',
  row: (r) => '<tr><td class="mono">' + t(r.sent_at) + '</td><td>'
    + esc(r.first_name || r.contact_id) + '</td><td class="mono" title="' + esc(r.body) + '">' + esc(r.variant_id)
    + '</td><td>' + r.step + '</td><td>'
    + (r.error ? '<span class="bad">Fehler</span>'
      : r.replied ? '<span class="ok">ja</span>' : '<span class="dim">—</span>')
    + '</td></tr>',
});

const logPager = pager({
  id: 'logpager', rows: 'logrows', url: '/api/events', filterParam: 'level',
  empty: '<tr><td colspan="3" class="dim">Nichts gefunden.</td></tr>',
  row: (e) => '<tr><td class="mono">' + t(e.at) + '</td><td class="'
    + (e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'dim') + '">'
    + esc(e.level) + '</td><td>' + esc(e.message) + '</td></tr>',
});

const pagers = [sendPager, logPager].filter(Boolean);
setInterval(() => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (pagers.some((p) => p.busy())) return;
  location.reload();
}, 20000);
` : ''}
</script>
</body></html>`;
}
