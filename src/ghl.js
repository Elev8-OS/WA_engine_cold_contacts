import { config } from './config.js';
import { logEvent } from './db.js';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

async function request(pathname, { method = 'GET', body, version, query } = {}) {
  const url = new URL(config.ghl.baseUrl + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = {
    Authorization: `Bearer ${config.ghl.token}`,
    Version: version || config.ghl.versionConversations,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }

      if (res.ok) return payload;

      if (RETRYABLE.has(res.status) && attempt < 4) {
        const wait = 1000 * 2 ** (attempt - 1);
        logEvent('warn', `GHL ${res.status} auf ${pathname} — Retry in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      const err = new Error(
        `GHL ${method} ${pathname} → ${res.status}: ${JSON.stringify(payload).slice(0, 400)}`
      );
      err.status = res.status;
      throw err;
    } catch (e) {
      lastError = e;
      const transient = e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause;
      if (transient && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * Sendet eine SMS über die Conversations API.
 * POST /conversations/messages  →  { conversationId, messageId }
 */
export async function sendSms({ contactId, message }) {
  const body = { type: 'SMS', contactId, message };
  if (config.ghl.fromNumber) body.fromNumber = config.ghl.fromNumber;

  const res = await request('/conversations/messages', {
    method: 'POST',
    body,
    version: config.ghl.versionConversations,
  });

  return {
    conversationId: res?.conversationId || null,
    messageId: res?.messageId || res?.messageIds?.[0] || null,
  };
}

/** Kontakt nachladen — nur für Anzeige und Telefon-Auflösung beim Import. */
export async function getContact(contactId) {
  const res = await request(`/contacts/${contactId}`, {
    version: config.ghl.versionContacts,
  });
  return res?.contact || null;
}

/** Kontakte per Freitext suchen (z. B. Telefonnummer beim CSV-Import auflösen). */
export async function searchContacts(query, limit = 20) {
  const res = await request('/contacts/', {
    version: config.ghl.versionContacts,
    query: { locationId: config.ghl.locationId, query, limit },
  });
  return res?.contacts || [];
}

/** Tag setzen, z. B. cha08-opted-out oder cha08-replied. */
export async function addTags(contactId, tags) {
  return request(`/contacts/${contactId}/tags`, {
    method: 'POST',
    body: { tags },
    version: config.ghl.versionContacts,
  });
}
