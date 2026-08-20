import { PAGE_CSS } from './css.js';
import { loginCard, LOGIN_JS, LOGOUT_JS, LOGOUT_LINK } from './auth-ui.js';

export function settingsPageHtml({ loggedIn = false } = {}) {
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
<div class="sub"><a href="/">&larr; Dashboard</a> &middot; <a href="/audience">Zielgruppe</a>${loggedIn ? LOGOUT_LINK : ''}</div>

${loggedIn ? '' : loginCard()}
${loggedIn ? `<div class="card">
  <button id="load" class="ghost" style="margin-top:0">Neu laden</button>
  <pre id="out" hidden></pre>
</div>` : ''}

${loggedIn ? `<div class="card">
  <h2>Kampagne beschreiben</h2>
  <div class="sub" style="margin:0 0 4px">
    Thema, Datum, Ort, Zielgruppe, was du erreichen willst. Je konkreter, desto
    brauchbarer die Varianten. Mit „Beschreibung speichern" bleibt der Text für
    das nächste Mal stehen. Die erzeugten Varianten landen unten als Vorschlag
    — gespeichert sind sie erst mit „Nachrichten speichern".
  </div>
  <textarea id="brief" placeholder="Beispiel: CHA-08 am 28. August, im OXO The Living. Zielgruppe sind Villa-Owner und Manager, die ich am Bali Villa Connect getroffen habe. Thema: echte Occupancy- und ADR-Zahlen aus Bali-Villen und was die besten Betriebe anders machen. Plätze beschränkt. Ziel: sie sollen antworten, damit ich ihnen die Details schicken kann."></textarea>
  <div class="row" style="margin-top:12px">
    <div><label>Sprache</label><input id="lang" value="Englisch"></div>
    <div class="row">
      <div><label>Varianten Step 1</label><input id="n1" type="number" min="1" max="8" value="4"></div>
      <div><label>Step 2</label><input id="n2" type="number" min="0" max="8" value="3"></div>
    </div>
  </div>
  <button id="savebrief">Beschreibung speichern</button>
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
</div>` : ''}

<script>
${loggedIn ? '' : LOGIN_JS}
${loggedIn ? LOGOUT_JS : ''}
${loggedIn ? `
const $ = (id) => document.getElementById(id);
const out = $('out');
const show = (v) => { out.hidden = false; out.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
const need = () => true;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
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
loadAll();

$('add').onclick = () => {
  newCount++;
  $('vars').appendChild(varRow({ id: '__new' + newCount, step: 1, label: '', body: '', active: true }));
};

$('savebrief').onclick = async () => {
  const btn = $('savebrief');
  const before = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'speichert \u2026';
  try {
    await call('/admin/brief', {
      method: 'POST',
      body: JSON.stringify({
        brief: $('brief').value,
        language: $('lang').value.trim() || 'Englisch',
        countStep1: parseInt($('n1').value, 10),
        countStep2: parseInt($('n2').value, 10),
      }),
    });
    show('Beschreibung gespeichert. Sie steht beim n\u00e4chsten \u00d6ffnen wieder da.');
  } catch (e) {
    show('Fehler: ' + e.message);
  }
  btn.disabled = false;
  btn.textContent = before;
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
    const NL = String.fromCharCode(10);
    let msg = r.variants.length + ' Varianten unten eingefügt — noch NICHT gespeichert.' + NL + NL;
    msg += 'Lies jeden Text, bevor du speicherst. Alte Varianten stehen weiter da; die, die du nicht willst, mit „Löschen" wegnehmen.';
    if (r.notes) msg += NL + NL + 'Hinweis vom Modell: ' + r.notes;
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
` : ''}
</script>
</body></html>`;
}
