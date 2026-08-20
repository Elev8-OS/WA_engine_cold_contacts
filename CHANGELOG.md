# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

Nichts offen.

---

## [1.2.0] — 2026-08-20

Alles im Tool einstellbar. Vorher lagen die Nachrichten in einer Datei im Repo und
das Tempo in Railway-Variablen — jede Änderung brauchte einen Commit oder einen
Redeploy. Jetzt liegt beides in der Datenbank auf dem Volume und gilt sofort.

### Hinzugefügt

- **Seite `/settings` mit Nachrichten-Editor.** Varianten im Browser anlegen,
  bearbeiten, aktivieren, löschen, mit lebender Zeichen- und SMS-Segment-Anzeige.
  Ab drei Segmenten wird der Zähler gelb — lange SMS kosten pro Segment.
- **Formular für Tempo, Follow-up, Bremsen und Betrieb.** 15 Werte, jeder mit
  Wertebereich und Erklärung. Jedes Feld zeigt, ob es aus der Datenbank kommt (**DB**)
  oder noch der Railway-Startwert ist (**ENV**), und lässt sich einzeln zurücksetzen.
- **Kampagnen-Enddatum.** Ab dem gesetzten Tag wird nichts mehr gesendet, auch wenn die
  Warteschlange voll ist. Das Dashboard zeigt einen Banner. Leer = kein Ende.
- **Tag-Auswahl aus GHL** unter `/audience` — Dropdown statt Freitext, gespeist aus dem
  dokumentierten Endpoint `GET /locations/{id}/tags`.
- **Endpoint-Scanner** unter `/audience`: probiert 14 plausible Smart-List-Pfade gegen
  die echte Location, beide Version-Header, und zeigt Statuscode und Antwort pro Pfad.
- **Neue Endpoints:** `GET /api/settings`, `POST /admin/settings`,
  `POST /admin/settings/reset`, `GET /api/pool`, `DELETE /admin/pool/:id`,
  `GET /api/audience/tags`, `GET /api/audience/discover`.
- **`test/settings.test.mjs`** — 33 Checks: Validierung pro Feld, Atomarität des Patches,
  Grenzen des Zufalls-Abstands über 200 Ziehungen, Enddatum-Sperre, Varianten-CRUD und
  Rückfall auf den Default bei kaputtem DB-Wert.

### Geändert

- **Railway-Variablen sind nur noch Startwerte.** Sie greifen, solange ein Wert unter
  `/settings` nie gesetzt wurde. Danach gewinnt die Datenbank.
- **`time.js` und `campaign.js` lesen zur Laufzeit** statt beim Import. Zeitzone,
  Sendefenster, Abstand, Cap, Follow-up und Bremsen wirken ohne Neustart.
- **Das Sync-Intervall wird jede Minute neu gelesen**, statt beim Start festzustehen.
- **`pool.json` ist nur noch die Erstbefüllung.** Sobald Varianten in der Datenbank
  liegen, wird die Datei ignoriert — sonst hätte jeder Deploy die im Editor
  geschriebenen Texte überschrieben. `POOL_SEED_ALWAYS=true` erzwingt das alte Verhalten.

### Wichtig zu wissen

- **Smart Lists sind über die HighLevel-API nicht erreichbar.** Der Probe-Lauf gegen die
  echte Location gab `400 Contact with id smart-lists not found` — GHL liest
  `/contacts/smart-lists` als Kontakt-ID. Die Pfade, die ein Drittanbieter-Projekt dafür
  nutzt, existieren in der öffentlichen API nicht. Contacts-Search und der Kontakt-Vollscan
  funktionieren dagegen beide.
- **Der Tag-Weg ersetzt die Smart List vollwertig:** in GHL die Smart List öffnen, alle
  auswählen, Bulk Action „Add Tag". Damit es dynamisch bleibt, in GHL einen Workflow mit
  denselben Bedingungen anlegen und dort „Add Tag" ausführen — dann wird jeder neue
  Kontakt automatisch getaggt und landet beim nächsten Sync in der Warteschlange.
- Der Token braucht zusätzlich `locations.readonly`, damit die Tag-Liste geladen werden kann.

---

## [1.1.0] — 2026-08-20

Zielgruppen-Steuerung. Vorher wurden Kontakte per CSV oder API in die Warteschlange
geschoben; jetzt wird die Liste direkt aus GHL gezogen und bleibt synchron.

### Hinzugefügt

- **Zielgruppen-Auswahl unter `/audience`** mit Dropdown, Speichern und Sofort-Sync.
  Admin-Key wird nur im Tab gehalten.
- **Drei Zielgruppen-Quellen:** `smartlist`, `tag`, `manual` (CSV / API wie bisher).
- **Automatischer Re-Sync** alle `AUDIENCE_SYNC_INTERVAL_MINUTES` Minuten, Default 60,
  plus einmal fünf Sekunden nach dem Start.
- **Prune beim Sync.** Kontakte, die nicht mehr in der Liste sind und noch keine
  Nachricht bekommen haben, fliegen aus der Warteschlange.
- **`GET /api/audience/probe`** — prüft gegen die echte Location, welche API-Wege
  nutzbar sind, und gibt eine Empfehlung zurück.
- **Zielgruppen-Kachel im Dashboard** mit Quelle, Zeitpunkt und Ergebnis des letzten Syncs.
- **`test/audience.test.mjs`** gegen einen lokalen Mock-GHL: beide API-Wege, der
  Fallback, Idempotenz des Re-Syncs und das Prune-Verhalten.

### Wichtig zu wissen

- Der Tag-Weg versucht zuerst `POST /contacts/search` und fällt bei Fehler oder leerem
  Ergebnis auf einen Kontakt-Vollscan mit clientseitiger Filterung zurück. Der genutzte
  Weg steht im Sync-Ergebnis unter `path`.
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
- **Opt-out-Erkennung** für stop, out, unsubscribe, remove, no thanks, not interested,
  berhenti, abmelden. Wird sofort respektiert und in GHL getaggt.
- **Reply-Rate-Bremse.** Fällt die Rate unter das Minimum, pausiert die Kampagne selbst.
- **Fehler-Bremse:** fünf API-Fehler innerhalb einer Stunde pausieren ebenfalls.
- **HTML-Status-Dashboard** mit Tages-Cap, Reply-Rate, Pool-Statistik pro Variante,
  letzten Sends und Log.
- **Admin-API:** `/admin/pause`, `/admin/resume`, `/admin/pool`, `/admin/contacts`,
  geschützt über den Header `x-admin-key`.
- **CSV-Import** über `node scripts/import-contacts.js`.
- **SQLite auf einem Railway-Volume** unter `/data/rotator.db`.
- **Start-Sicherung:** `START_PAUSED=true` und `DRY_RUN=true` als Default.

### Wichtig zu wissen

- Der `Version`-Header der Conversations API ist über
  `GHL_API_VERSION_CONVERSATIONS` konfigurierbar, Default `2021-04-15`.
- Ohne den Inbound-Webhook laufen Reply-Tracking, Opt-out und Reply-Rate-Bremse ins Leere.
- Ohne Volume ist die Datenbank nach jedem Deploy leer, und Kontakte werden doppelt
  angeschrieben.
