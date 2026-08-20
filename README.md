# WA_engine_cold_contacts

Rotierender Kaltkontakt-Versand über GoHighLevel. Ein Pool aus Nachrichten-Varianten,
gleichmässig rotiert, gedrosselt versendet, mit Reply-Tracking und automatischer Bremse.

**Kanal: SMS.** Der Versand läuft über die GHL Conversations API mit `type: "SMS"` —
also über dieselbe SMS-Funktion und dieselbe Location-Nummer wie ein manueller Send
aus der Inbox. Keine Twilio-Direktanbindung, kein WhatsApp-Template-Genehmigungsprozess.

**Was es löst:** GHL kann Snippets nicht randomisieren, und die Split-Action deckelt bei
5 Varianten mit fixer Zuweisung pro Kontakt. Hier liegt der Pool in einer Datenbank, die
Rotation ist frei, und das Tempo ist der eigentliche Punkt — 30 Nachrichten über acht
Stunden verteilt sehen für den Carrier anders aus als 30 Nachrichten in zwei Minuten.

---

## Die drei Seiten

| Seite | Wofür |
|---|---|
| `/` | Dashboard: Tages-Cap, Reply-Rate, Pool-Statistik, letzte Sends, Log |
| `/settings` | **Nachrichten anlegen und bearbeiten**, Tempo, Follow-up, Bremsen, Enddatum |
| `/audience` | Zielgruppe wählen (Tag oder Smart List), synchronisieren, API prüfen |

Alle drei brauchen den `ADMIN_KEY` für schreibende Aktionen. Der Key steht in den
Railway-Variablen und wird im Browser nur im Tab gehalten, nie gespeichert.

---

## Wo stelle ich was ein

**Nachrichten:** `/settings` → Nachrichten. Step 1 = Erstnachricht, Step 2 = Follow-up.
`{{first_name}}` wird pro Kontakt eingesetzt, ohne Vornamen fällt es auf `there` zurück.
Die Zeichen- und Segment-Anzeige läuft mit: ab drei SMS-Segmenten wird sie gelb.

`pool.json` im Repo ist nur die **Erstbefüllung**. Sobald Varianten in der Datenbank
liegen, wird die Datei ignoriert — sonst würde jeder Deploy deine Texte überschreiben.

**Tempo und Bremsen:** `/settings` → unteres Formular. Gilt sofort, ohne Redeploy.
Jedes Feld zeigt **DB** (von dir gesetzt) oder **ENV** (noch der Railway-Startwert) und
lässt sich einzeln zurücksetzen.

| Einstellung | Default | Was sie verhindert |
|---|---|---|
| Nachrichten pro Tag | 30 | Volumen-Flag beim Carrier |
| Sendefenster | 9–18 Uhr | Nachtnachrichten, die als Spam gemeldet werden |
| Abstand min/max | 240–900 s | Burst-Muster. Der Abstand ist zufällig, nicht getaktet |
| Kampagne endet am | leer | Läuft weiter, bis die Queue leer ist |
| Follow-up nach | 48 h | Zu schnelles Nachfassen |
| Max. Nachrichten ohne Antwort | 2 | Die dritte unbeantwortete Nachricht holt die Reports |
| Reply-Rate Minimum | 0.2 | Kampagne pausiert selbst, wenn die Liste kalt ist |
| Testmodus | an | Es geht nichts raus, solange er an ist |

**Zielgruppe:** `/audience`. Siehe unten.

---

## Zielgruppe: warum Tag statt Smart List

**Smart Lists sind über die HighLevel-API nicht erreichbar.** Der Probe-Lauf gegen die
echte Location gibt `400 Contact with id smart-lists not found` — GHL liest
`/contacts/smart-lists` als Kontakt-ID. Es gibt dafür keinen dokumentierten v2-Endpoint.
Der Button „Smart-List-Endpoints scannen" probiert 14 plausible Pfade durch und zeigt
jeden Statuscode, falls HighLevel das ändert.

Der Weg, der funktioniert:

1. In GHL die Smart List öffnen, alle Kontakte auswählen, Bulk Action **Add Tag**,
   z. B. `cha08-invite`.
2. Unter `/audience` Typ **Tag** wählen, „Tags laden", Tag aus dem Dropdown,
   „Speichern & synchronisieren".

Damit die Liste dynamisch bleibt statt einmalig getaggt: in GHL einen **Workflow** mit
denselben Bedingungen wie die Smart List anlegen, Action **Add Tag**. Dann wird jeder
neue passende Kontakt automatisch getaggt und landet beim nächsten Sync in der
Warteschlange — der Sync läuft standardmässig jede Stunde.

Ein Re-Sync setzt **niemals** einen bereits angeschriebenen, geantworteten oder
abgemeldeten Kontakt zurück. Doppelversand ist ausgeschlossen. Wer die Liste verlässt und
noch nichts bekommen hat, fliegt aus der Warteschlange.

---

## Rotation: warum kein reiner Zufall

`Math.random()` über vier Varianten liefert regelmässig dreimal denselben Text
hintereinander. Für Spam-Filter ist das exakt das Muster, das du vermeiden willst.

Der Rotator zieht deshalb **zufällig aus den am wenigsten benutzten Varianten** und
überspringt die letzte, solange es Alternativen gibt. Gleichmässige Verteilung, keine
Wiederholungsserien, Reihenfolge trotzdem unvorhersehbar:

```bash
npm run simulate 40
```

---

## Setup

### GHL Private Integration Token

Settings → Private Integrations → New. Scopes:

| Scope | Wofür |
|---|---|
| `conversations/message.write` | SMS senden |
| `conversations.readonly` | Konversationen lesen |
| `contacts.readonly` | Kontakte laden |
| `contacts.write` | Tags `cha08-replied` / `cha08-opted-out` setzen |
| `locations.readonly` | Tag-Liste für das Dropdown |

Token und Location ID in Railway → Variables als `GHL_TOKEN` und `GHL_LOCATION_ID`.

### Reply-Webhook in GHL

Workflow anlegen:

- Trigger: **Customer Replied**, Channel SMS
- Action: **Webhook** → `POST https://<deine-domain>/webhooks/ghl/inbound`

Payload braucht mindestens `contactId` und `body`. Ohne diesen Webhook laufen
Reply-Tracking, Opt-out-Erkennung und die Reply-Rate-Bremse ins Leere — und ein Kontakt
bekommt ein Follow-up, obwohl er längst geantwortet hat.

### Deployment auf Railway

Drei Dinge nicht vergessen:

1. **Volume** mit Mount Path `/data`, dazu `DATA_DIR=/data`. Ohne Volume ist die
   Datenbank nach jedem Deploy leer — Kontakte, Historie, Reply-Rate und alle
   Einstellungen weg, und Kontakte werden doppelt angeschrieben.
2. **Variablen** aus `.env.example` eintragen. `START_PAUSED=true` lassen.
3. **Domain generieren** für Dashboard und Webhook.

Der Service muss durchlaufen — kein Cron, kein Sleep. Alle 30 Sekunden prüft ein Tick,
ob eine Nachricht fällig ist, und sendet maximal eine. Das Tempo macht der Abstand.

---

## Go-live

1. Token und Location ID setzen.
2. Reply-Webhook in GHL anlegen.
3. `/audience`: „API prüfen", dann Tag wählen und synchronisieren.
4. `/settings`: Nachrichten schreiben, Platzhalter ersetzen, Tempo prüfen.
5. Im **Testmodus** freigeben (`POST /admin/resume`) und im Dashboard schauen, dass
   Rotation und Rendering stimmen.
6. Testmodus aus, mit einem **20er-Batch** starten, Reply-Rate beobachten. Erst hochfahren,
   wenn sie hält.

```bash
curl -X POST https://<domain>/admin/resume -H "x-admin-key: $ADMIN_KEY"
```

---

## Endpoints

| Endpoint | Zweck |
|---|---|
| `GET /api/status` | Alles als JSON |
| `GET /healthz` | Healthcheck |
| `POST /admin/resume` · `/admin/pause` | Versand starten und stoppen |
| `GET /api/pool` · `POST /admin/pool` · `DELETE /admin/pool/:id` | Varianten |
| `GET /api/settings` · `POST /admin/settings` · `POST /admin/settings/reset` | Einstellungen |
| `GET /api/audience` · `POST /admin/audience` · `POST /admin/sync` | Zielgruppe |
| `GET /api/audience/tags` · `/smartlists` · `/probe` · `/discover` | GHL-Abfragen |
| `POST /admin/contacts` | Kontakte manuell nachschieben |

Schreibende Endpoints brauchen den Header `x-admin-key`.

---

## Tests

```bash
npm test              # Einstellungen + Zielgruppen-Sync gegen einen Mock-GHL
npm run simulate 40   # Rotation: Verteilung und längste Wiederholungsserie
```

---

## Struktur

```
src/config.js     Env-Handling, Validierung beim Start
src/settings.js   Laufzeit-Einstellungen, DB überschreibt Env
src/db.js         SQLite-Schema, State, Event-Log
src/ghl.js        API-Client mit Retry, Backoff und rohem GET für den Scanner
src/pool.js       Rotation, Rendering, Varianten-CRUD
src/audience.js   Zielgruppen-Quellen, Sync, Probe, Endpoint-Scanner
src/time.js       Zeitzone, Sendefenster, Zufalls-Abstand
src/campaign.js   Sende-Engine, Guards, Inbound-Verarbeitung
src/server.js     Dashboard, Seiten, Webhook, Admin-API
src/index.js      Start, Tick-Loop, Sync-Loop, Shutdown
```

---

## Was zu prüfen bleibt

Die GHL-API-Versions-Header sind über Env konfigurierbar
(`GHL_API_VERSION_CONVERSATIONS`, Default `2021-04-15`). HighLevel ändert die
gelegentlich — kommt ein 400 oder 422 zurück, ist das der erste Verdächtige. Ein
Testsend an die eigene Nummer im Live-Modus klärt das in einer Minute.
