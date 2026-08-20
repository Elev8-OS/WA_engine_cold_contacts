import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Login mit Session-Cookie.
 *
 * Vorher stand in jeder Seite ein Feld für den ADMIN_KEY, und du hast ihn bei
 * jedem Aufruf neu eingefügt. Das war unbequem und schlechter für die
 * Sicherheit: ein Secret, das ständig durch die Zwischenablage geht, landet
 * irgendwann im falschen Fenster.
 *
 * Jetzt: einmal anmelden, danach ein HttpOnly-Cookie. Das Cookie ist ein
 * signierter Token, kein Session-Store nötig — der Service kann neu starten,
 * ohne dich auszuloggen. Der Header x-admin-key funktioniert weiter, damit
 * curl und Automatisierung unverändert laufen.
 */

export const COOKIE = 'wa_sid';
const TTL_DAYS = 30;

function sign(payload) {
  return crypto.createHmac('sha256', config.ops.adminKey).update(payload).digest('base64url');
}

/** Token = Ablaufzeitpunkt + Signatur darüber. */
export function issueToken(now = Date.now()) {
  const exp = String(now + TTL_DAYS * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}

export function verifyToken(token, now = Date.now()) {
  if (!token || !config.ops.adminKey) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;

  const expected = sign(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function isLoggedIn(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

/** Header für curl, Cookie für den Browser. */
export function isAuthorized(req) {
  const key = req.get('x-admin-key') || req.query.key;
  if (config.ops.adminKey && key === config.ops.adminKey) return true;
  return isLoggedIn(req);
}

export function setSessionCookie(req, res) {
  // Hinter dem Railway-Proxy kommt die Anfrage intern per http an, aussen ist
  // sie https — deshalb wird Secure am Forwarded-Header entschieden.
  const secure = (req.get('x-forwarded-proto') || req.protocol) === 'https';
  const parts = [
    `${COOKIE}=${issueToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TTL_DAYS * 24 * 3600}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
