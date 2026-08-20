import { PAGE_CSS } from './css.js';
import { loginCard, LOGIN_JS, LOGOUT_JS, LOGOUT_LINK } from './auth-ui.js';
import { getAudience } from '../audience.js';

export function audiencePageHtml({ loggedIn = false } = {}) {
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
<div class="sub"><a href="/">&larr; Dashboard</a> &middot; <a href="/settings">Einstellungen</a>${loggedIn ? LOGOUT_LINK : ''}</div>

<div class="card">
  <h2>Aktuell</h2>
  <div class="kv"><b>Quelle:</b> ${esc(a.type)}${a.id ? ` &middot; ${esc(a.label || a.id)}` : ''}</div>
  <div class="kv"><b>Letzter Sync:</b> ${a.lastSyncResult ? esc(a.lastSyncResult) : '<span class="dim">nie</span>'}</div>
</div>

${loggedIn ? '' : loginCard()}

${loggedIn ? `<div class="card">
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
</div>` : ''}

<script>
${loggedIn ? '' : LOGIN_JS}
${loggedIn ? LOGOUT_JS : ''}
${loggedIn ? `
const $ = (id) => document.getElementById(id);
const out = $('out');
const show = (v) => { out.hidden = false; out.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
const need = () => true;

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
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
` : ''}
</script>
</body></html>`;
}
