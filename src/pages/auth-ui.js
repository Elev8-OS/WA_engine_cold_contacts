/**
 * Login-Karte und der zugehörige Client-Code, für alle drei Seiten gleich.
 * Ist die Session aktiv, sieht man hier nichts mehr — nur den Abmelden-Link.
 */

export function loginCard() {
  return `<div class="card" id="logincard">
  <h2>Anmelden</h2>
  <div class="sub" style="margin:0 0 10px">
    Einmal den ADMIN_KEY eingeben. Danach bleibst du 30 Tage angemeldet.
  </div>
  <input id="lk" type="password" placeholder="ADMIN_KEY" autocomplete="current-password">
  <button id="lbtn">Anmelden</button>
  <span id="lmsg" class="dim" style="font-size:12px; margin-left:8px"></span>
</div>`;
}

export const LOGIN_JS = `
const lk = document.getElementById('lk');
const lmsg = document.getElementById('lmsg');
async function doLogin() {
  const key = lk.value.trim();
  if (!key) { lmsg.textContent = 'Key fehlt.'; return; }
  lmsg.textContent = 'prüfe …';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      lmsg.textContent = b.error || 'Login fehlgeschlagen.';
      return;
    }
    lmsg.textContent = 'angemeldet, lade neu …';
    location.reload();
  } catch (e) { lmsg.textContent = 'Fehler: ' + e.message; }
}
document.getElementById('lbtn').onclick = doLogin;
lk.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
lk.focus();
`;

export const LOGOUT_JS = `
const lo = document.getElementById('logout');
if (lo) lo.onclick = async (e) => {
  e.preventDefault();
  await fetch('/logout', { method: 'POST' });
  location.reload();
};
`;

export const LOGOUT_LINK = ' &middot; <a href="#" id="logout">Abmelden</a>';
