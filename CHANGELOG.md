# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

Nichts offen.

---

## [1.1.0] — 2026-08-20

Zielgruppen-Steuerung. Vorher wurden Kontakte per CSV oder API in die Warteschlange
geschoben; jetzt wird die Liste direkt aus GHL gezogen und bleibt synchron.

### Hinzugefügt

- **Smart-List-Auswahl unter `/audience`.** Dropdown mit den Smart Lists der Location,
  Auswahl speichern, sofort synchronisieren. Admin-Key wird nur im Tab gehalten.
- **Drei Zielgruppen-Quellen:** `smartlist` (direkt aus GHL), `tag` (Kontakte mit einem
  bestimmten Tag), `manual` (CSV / API wie bisher).
- **Automatischer Re-Sync** alle `AUDIENCE_SYNC_INTERVAL_MINUTES` Minuten, Default 60,
  plus einmal fünf Sekunden nach dem Start. Smart Lists sind dynamisch — wer neu
  reinrutscht, landet ohne Handarbeit in der Warteschlange.
- **Prune beim Sync.** Kontakte, die nicht mehr in der Liste sind und noch keine
  Nachricht bekommen haben, fliegen aus der Warteschlange. Abschaltbar über
  `AUDIENCE_PRUNE_ON_SYNC=false`.
- **`GET /api/audience/probe`** — prüft in einem Aufruf gegen die echte Location, welche
  API-Wege nutzbar sind (Smart Lists, Contacts-Search, Kontakt-Vollscan) und gibt eine
  Empfehlung zurück.
- **Neue Endpoints:** `GET /api/audience`, `GET /api/audience/smartlists`,
  `POST /admin/audience`, `POST /admin/sync`.
- **Zielgruppen-Kachel im Dashboard** mit Quelle, Zeitpunkt und Ergebnis des letzten Syncs.
- **Testsuite** gegen einen lokalen Mock-GHL: `node test/audience.test.mjs`. Deckt beide
  API-Wege, den Fallback, Idempotenz des Re-Syncs und das Prune-Verhalten ab.

### Wichtig zu wissen

- Die Smart-List-Endpoints (`/contacts/smart-lists…`) stehen **nicht in der offiziellen
  HighLevel-v2-Doku**. Sie funktionieren auf vielen Locations, aber nicht garantiert auf
  jeder. Deshalb gibt es die Probe und den Tag-Weg als vollwertige Alternative.
- Der Tag-Weg versucht zuerst `POST /contacts/search` und fällt bei Fehler oder leerem
  Ergebnis auf einen Kontakt-Vollscan mit clientseitiger Filterung zurück. Der genutzte
  Weg steht im Sync-Ergebnis unter `path` und im Dashboard.
- Ein Re-Sync setzt **niemals** einen bereits angeschriebenen, geantworteten oder
  abgemeldeten Kontakt zurück. Doppelversand ist damit ausgeschlossen.

---

## [1.0.0] — 2026-08-20

Erste Version. Rotierender SMS-Versand über GoHighLevel, deployt auf Railway.

### Hinzugefügt

- **Nachrichten-Pool mit gleichmässiger Rotation.** Zufällig aus den am wenigsten
  benutzten Varianten, die letzte wird übersprungen. Kein reiner Zufall — der klumpt und
  schickt dieselbe Variante dreimal hintereinander, was genau das Spam-Muster ist, das
  vermieden werden soll. Prüfbar mit `npm run simulate 40`.
- **Versand über die GHL Conversations API** mit `type: "SMS"`, also über dieselbe
  SMS-Funktion und Location-Nummer wie ein manueller Send aus der Inbox.
- **Gedrosseltes Tempo:** Tages-Cap, Sendefenster in lokaler Zeit, zufälliger Abstand
  zwischen zwei Sends. Ein Tick alle 30 Sekunden sendet maximal eine Nachricht.
- **Follow-up-Step** nach `FOLLOWUP_AFTER_HOURS` Stunden ohne Antwort, mit eigenem
  Varianten-Pool und hartem Deckel über `MAX_MESSAGES_WITHOUT_REPLY`.
- **Reply-Tracking** über den GHL-Inbound-Webhook (`POST /webhooks/ghl/inbound`).
  Antwort stoppt jedes Follow-up und taggt den Kontakt.
- **Opt-out-Erkennung** für stop, out, unsubscribe, remove, no thanks, not interested,
  berhenti, abmelden. Wird sofort respektiert und in GHL getaggt.
- **Reply-Rate-Bremse.** Fällt die Rate der letzten `REPLY_RATE_WINDOW` Sends unter
  `REPLY_RATE_FLOOR`, pausiert die Kampagne selbst. Greift erst ab
  `REPLY_RATE_MIN_SAMPLE` Sends, damit ein langsamer Start nicht sofort bremst.
- **Fehler-Bremse:** fünf API-Fehler innerhalb einer Stunde pausieren ebenfalls.
- **HTML-Status-Dashboard** mit Tages-Cap, Reply-Rate, Pool-Statistik pro Variante,
  letzten Sends und Log. Lädt alle 20 Sekunden neu.
- **Admin-API:** `/admin/pause`, `/admin/resume`, `/admin/pool`, `/admin/contacts`,
  geschützt über den Header `x-admin-key`.
- **CSV-Import** über `node scripts/import-contacts.js`, mit Auflösung der Contact-ID
  über die Telefonnummer als Rückfalloption.
- **SQLite auf einem Railway-Volume** unter `/data/rotator.db`. Kontakte, Sende-Historie
  und Reply-Rate überleben Redeploys.
- **Start-Sicherung:** `START_PAUSED=true` und `DRY_RUN=true` als Default. Es geht nichts
  raus, bis beides bewusst umgestellt wird.

### Wichtig zu wissen

- Der `Version`-Header der Conversations API ist über
  `GHL_API_VERSION_CONVERSATIONS` konfigurierbar, Default `2021-04-15`. HighLevel ändert
  die gelegentlich — bei einem 400 oder 422 ist das der erste Verdächtige.
- Ohne den Inbound-Webhook laufen Reply-Tracking, Opt-out und Reply-Rate-Bremse ins Leere.
- Ohne Volume ist die Datenbank nach jedem Deploy leer, und Kontakte werden doppelt
  angeschrieben.
