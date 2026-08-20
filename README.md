# WA_engine_cold_contacts

Rotierender Kaltkontakt-Versand über GoHighLevel. Ein Pool aus Nachrichten-Varianten,
gleichmässig rotiert, gedrosselt versendet, mit Reply-Tracking und automatischer Bremse.

**Kanal: SMS.** Der Versand läuft über die GHL Conversations API mit `type: "SMS"` —
also über dieselbe SMS-Funktion und dieselbe Location-Nummer wie ein manueller Send
aus der Inbox. Keine Twilio-Direktanbindung, kein WhatsApp-Template-Genehmigungsprozess.
Der Repo-Name sagt WA, weil der Pool später auch WhatsApp bedienen soll; dafür braucht
jede Variante dann ein von Meta genehmigtes Template.

**Was es löst:** GHL kann Snippets nicht randomisieren, und die Split-Action deckelt bei
5 Varianten mit fixer Zuweisung pro Kontakt. Hier liegt der Pool in einer Datenbank, die
Rotation ist frei, und das Tempo ist der eigentliche Punkt — 30 Nachrichten über acht
Stunden verteilt sehen für den Carrier anders aus als 30 Nachrichten in zwei Minuten.

---

## Live

| | |
|---|---|
| Dashboard | https://wa-engine-production-9cc8.up.railway.app |
| Railway-Projekt | `WA_engine_cold_contacts` → Service `wa-engine` |
| Volume | `wa-engine-data`, gemountet auf `/data` |
| Healthcheck | `/healthz` |

Der Service startet bewusst **pausiert** und im **Dry-Run**. Es geht nichts raus, bis
beides umgestellt ist.

---

## Rotation: warum kein reiner Zufall

`Math.random()` über vier Varianten liefert regelmässig dreimal denselben Text
hintereinander. Für Spam-Filter ist das exakt das Muster, das du vermeiden willst.

Der Rotator zieht deshalb **zufällig aus den am wenigsten benutzten Varianten** und
überspringt die letzte, solange es Alternativen gibt. Ergebnis: gleichmässige Verteilung,
keine Wiederholungsserien, Reihenfolge trotzdem unvorhersehbar. Nachprüfbar mit:

```bash
npm run simulate 40
```

Erwartete Ausgabe: gleiche Anteile pro Variante, längste Wiederholungsserie 1.

---

## Go-live in fünf Schritten

### 1. GHL Private Integration Token

Settings → Private Integrations → New. Scopes:

| Scope | Wofür |
|---|---|
| `conversations/message.write` | SMS senden |
| `conversations.readonly` | Konversationen lesen |
| `contacts.readonly` | Kontakte auflösen |
| `contacts.write` | Tags `cha08-replied` / `cha08-opted-out` setzen |

Dann in Railway → Variables: `GHL_TOKEN` und `GHL_LOCATION_ID` von `REPLACE_ME` auf die
echten Werte setzen.

### 2. Reply-Webhook in GHL

Workflow anlegen:

- Trigger: **Customer Replied**, Channel SMS
- Action: **Webhook** → `POST https://wa-engine-production-9cc8.up.railway.app/webhooks/ghl/inbound`

Payload braucht mindestens `contactId` und `body`. Ohne diesen Webhook laufen
Reply-Tracking, Opt-out-Erkennung und die Reply-Rate-Bremse ins Leere — und ein Kontakt
bekommt ein Follow-up, obwohl er längst geantwortet hat.

### 3. Pool füllen

`pool.json` bearbeiten, Platzhalter in eckigen Klammern ersetzen: `[DATE]`, `[VENUE]`,
`[TOPIC]`, `[AREA]`, `[HOOK]`, `[X]`. `{{first_name}}` wird pro Kontakt eingesetzt, ohne
Vornamen fällt es auf `there` zurück.

`step: 1` = Erstnachricht, `step: 2` = Follow-up. Varianten mit `"active": false` bleiben
im Pool, werden aber nicht gezogen.

Der Pool wird bei jedem Start aus `pool.json` eingelesen — Commit auf `main` reicht,
Railway deployt automatisch. Ohne Redeploy geht es über `POST /admin/pool`.

### 4. Kontakte importieren

```bash
curl -X POST https://wa-engine-production-9cc8.up.railway.app/admin/contacts \
  -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '[{"contact_id":"abc123","first_name":"Made"}]'
```

Oder lokal aus CSV, mit Spalten `contact_id`, `first_name`, `phone`:

```bash
node scripts/import-contacts.js contacts.csv
```

Mit `contact_id` ist der Import exakt; nur mit `phone` wird über die GHL-Suche aufgelöst —
**das Ergebnis kontrollieren**, Telefon-Matching ist nie hundertprozentig.

### 5. Erst Dry-Run, dann scharf

Mit `DRY_RUN=true` einmal freigeben und im Dashboard prüfen: Rotation korrekt, Rendering
korrekt, Tempo plausibel.

```bash
curl -X POST https://wa-engine-production-9cc8.up.railway.app/admin/resume \
  -H "x-admin-key: $ADMIN_KEY"
```

Danach `DRY_RUN=false` in Railway setzen (redeployt automatisch), mit einem
**20er-Testbatch** starten und die Reply-Rate beobachten. Erst hochfahren, wenn sie hält.

---

## Betrieb

| Endpoint | Zweck |
|---|---|
| `GET /` | Dashboard, lädt alle 20s neu |
| `GET /api/status` | Alles als JSON |
| `GET /healthz` | Healthcheck |
| `POST /admin/resume` | Versand starten |
| `POST /admin/pause` | Versand stoppen, Body `{"reason":"..."}` |
| `POST /admin/pool` | Varianten live ersetzen |
| `POST /admin/contacts` | Kontakte nachschieben |

Admin-Endpoints brauchen den Header `x-admin-key: <ADMIN_KEY>`. Der Key steht in den
Railway-Variablen.

---

## Die eingebauten Bremsen

| Bremse | Default | Was sie verhindert |
|---|---|---|
| `DAILY_CAP` | 30 | Volumen-Flag beim Carrier |
| `SEND_WINDOW_START/END` | 9–18 Uhr | Nachtnachrichten, die als Spam gemeldet werden |
| `MIN/MAX_GAP_SECONDS` | 240–900 s | Burst-Muster. Der Abstand ist zufällig, nicht getaktet |
| `MAX_MESSAGES_WITHOUT_REPLY` | 2 | Die dritte unbeantwortete Nachricht holt die Reports |
| `FOLLOWUP_AFTER_HOURS` | 48 | Zu schnelles Nachfassen |
| `REPLY_RATE_FLOOR` | 0.2 | Kampagne pausiert automatisch, wenn die Liste kalt ist |
| STOP-Wörter | stop, out, unsubscribe, remove, berhenti, … | Opt-out wird sofort respektiert und getaggt |

Die Reply-Rate-Bremse greift erst ab `REPLY_RATE_MIN_SAMPLE` Sends (Default 15), damit ein
langsamer Start nicht sofort pausiert. Nach einer Auto-Pause steht der Grund im Dashboard;
Freigabe nur manuell über `/admin/resume`.

Fünf API-Fehler innerhalb einer Stunde pausieren ebenfalls — das ist meist ein abgelaufener
Token oder eine gesperrte Nummer, und Weitersenden macht es schlimmer.

---

## Struktur

```
src/config.js     Env-Handling, Validierung beim Start
src/db.js         SQLite-Schema, State, Event-Log
src/ghl.js        API-Client mit Retry und Backoff
src/pool.js       Rotation, Rendering, Pool-Statistik
src/time.js       Zeitzone, Sendefenster, Zufalls-Gap
src/campaign.js   Sende-Engine, Guards, Inbound-Verarbeitung
src/server.js     Dashboard, Webhook, Admin-API
src/index.js      Start, Tick-Loop, Shutdown
```

Zustand liegt in SQLite auf dem Volume unter `/data/rotator.db`. Der Service muss
durchlaufen — kein Cron, kein Sleep. Alle 30 Sekunden prüft ein Tick, ob eine Nachricht
fällig ist, und sendet maximal eine. Das Tempo macht der Gap, nicht der Tick.

---

## Was zu prüfen bleibt

Die GHL-API-Versions-Header sind über Env konfigurierbar
(`GHL_API_VERSION_CONVERSATIONS`, Default `2021-04-15`). HighLevel ändert die gelegentlich —
kommt ein 400 oder 422 zurück, ist das der erste Verdächtige. Ein Testsend an die eigene
Nummer im Live-Modus klärt das in einer Minute.
