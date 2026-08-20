import express from 'express';
import { config } from './config.js';
import { db, logEvent, setState } from './db.js';
import { handleInbound, stats, pause, resume } from './campaign.js';
import { poolStats, upsertVariants, listVariants, deleteVariant } from './pool.js';
import { settings, settingsDetail, setSettings, resetSetting } from './settings.js';
import { getBrief, generateVariants } from './generate.js';
import { isAuthorized, isLoggedIn, setSessionCookie, clearSessionCookie } from './auth.js';
import { dashboardHtml } from './pages/dashboard.js';
import { audiencePageHtml } from './pages/audience.js';
import { settingsPageHtml } from './pages/settings.js';
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
    if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  // ── Login ──────────────────────────────────────────────────────────────────
  // Einmal anmelden, danach ein HttpOnly-Cookie für 30 Tage. Der Key muss nicht
  // mehr auf jeder Seite neu eingegeben werden.
  app.post('/login', (req, res) => {
    const key = String(req.body?.key || '');
    if (!config.ops.adminKey || key !== config.ops.adminKey) {
      logEvent('warn', 'Fehlgeschlagener Login-Versuch');
      return res.status(401).json({ error: 'Falscher Key' });
    }
    setSessionCookie(req, res);
    logEvent('info', 'Angemeldet');
    res.json({ ok: true });
  });

  app.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => res.json({ loggedIn: isLoggedIn(req) }));

  // ── Inbound-Webhook aus GHL ─────────────────────────────────────────────────────
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

  // Brief speichern, ohne zu generieren.
  //
  // Bis hierher wurde der Brief nur als Nebenwirkung des Generators abgelegt:
  // wer ihn anpasste und die Seite neu lud, fand den alten Stand vor. Einen
  // Text überarbeitet man aber mehrmals, bevor man das Modell darauf loslässt.
  app.post('/admin/brief', requireAdmin, (req, res) => {
    try {
      const b = req.body || {};
      const text = String(b.brief ?? '').trim();
      setState('campaign_brief', text);
      if (b.language !== undefined) {
        setState('campaign_language', String(b.language).trim() || 'Englisch');
      }
      if (b.countStep1 !== undefined) {
        setState('campaign_count_step1', String(Math.min(8, Math.max(1, Number(b.countStep1) || 4))));
      }
      if (b.countStep2 !== undefined) {
        setState('campaign_count_step2', String(Math.min(8, Math.max(0, Number(b.countStep2) || 0))));
      }
      logEvent('info', `Brief gespeichert (${text.length} Zeichen)`);
      res.json(getBrief());
    } catch (e) {
      logEvent('warn', `Brief speichern: ${e.message}`);
      res.status(400).json({ error: e.message });
    }
  });

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

  // ── Nachrichten-Pool ──────────────────────────────────────────────────────
  app.get('/api/pool', requireAdmin, (_req, res) => res.json({ variants: listVariants() }));

  app.delete('/admin/pool/:id', requireAdmin, (req, res) => {
    const gone = deleteVariant(req.params.id);
    if (!gone) return res.status(404).json({ error: 'Variante nicht gefunden' });
    logEvent('info', `Variante ${req.params.id} gelöscht`);
    res.json({ deleted: req.params.id });
  });

  // ── Seiten ────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.type('html').send(dashboardHtml({ loggedIn: isLoggedIn(req) }));
  });

  app.get('/audience', (req, res) => {
    res.type('html').send(audiencePageHtml({ loggedIn: isLoggedIn(req) }));
  });

  app.get('/settings', (req, res) => {
    res.type('html').send(settingsPageHtml({ loggedIn: isLoggedIn(req) }));
  });

  return app;
}
