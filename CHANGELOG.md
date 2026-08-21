# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

Nichts offen.

---

## [1.7.0] — 2026-08-21

Blättern statt abschneiden. Das Dashboard hat die letzten 20 Sends und 15 Log-Zeilen
gezeigt, alles Ältere war da, aber nicht erreichbar.

### Hinzugefügt

- **Pager unter der Sends-Tabelle und unter dem Log.** Seitengrösse 25 / 50 / 100 / 250,
  vor und zurück, Sprung auf die erste Seite, und rechts steht immer, was man gerade
  sieht: „26–50 von 1.240".
- **Filter und Suche.** Sends: alle, nur mit Antwort, ohne Antwort, nur Fehler; Suche
  über Vorname, Kontakt-ID und Varianten-ID. Log: nach Level, Suche in der Meldung.
- **`GET /api/sends` und `GET /api/events`** mit `limit` (max 500), `offset`, Filter und
  `q`. Beide liefern die Gesamtzahl mit, damit die Oberfläche weiss, wie weit sie kommt.
  Beide brauchen eine Anmeldung — der Verlauf enthält Kontaktdaten.
- **`src/history.js`** als einzige Stelle für diese Abfragen, plus `test/history.test.mjs`
  mit 37 Checks: Grenzen der Seitengrösse, Blättern ohne Lücke und ohne Doppelte,
  jeder Filter, Suche, kombiniert, und der Ringpuffer des Logs.
- **Der Sendetext steht als Tooltip auf der Varianten-Spalte.** Man sieht, was wirklich
  rausgegangen ist, ohne die Tabelle zu verbreitern.
- **`EVENT_LOG_LIMIT`**, Default 5000 statt fest 500. Beschnitten wird über die
  Id-Grenze und nur bei jedem 50. Eintrag, statt bei jedem Log-Aufruf mit einer
  Unterabfrage über die ganze Tabelle.

### Geändert

- **Der Auto-Reload hält sich zurück.** Solange geblättert, gefiltert oder gesucht
  wird — oder der Cursor in einem Feld steht — lädt die Seite nicht neu und wirft
  einen nicht auf Seite 1 zurück.
- Ohne Anmeldung zeigt die Seite nur die erste Seite und darunter die Gesamtzahl.

### Wichtig zu wissen

- **Sends werden nie beschnitten.** Der komplette Versandverlauf bleibt in der Datenbank
  auf dem Volume, egal wie lang die Kampagne läuft. Nur das Log ist ein Ringpuffer.

---

## [1.6.0] — 2026-08-21

Drei Dinge, die der Live-Betrieb aufgedeckt hat. Alle drei sind Konstruktionsfehler
gewesen, nicht Bedienfehler.

### Behoben

- **Die Reply-Rate-Bremse hat Nachrichten mitgezählt, die eine Stunde alt waren.**
  Bei Kaltkontakt kommen Antworten über Tage, nicht über Minuten — die Bremse hat
  also für eine Rate pausiert, die nur bedeutete "das hat noch niemand gelesen".
  Sends, die jünger sind als **Antworten reifen lassen (Stunden)** (neu, Default 24),
  zählen jetzt nicht in die Rate. Die Dashboard-Kachel zeigt zusätzlich, wie viele
  Sends noch reifen.
- **`no_variant` und `error` waren Endstationen.** Ein kurz leerer Pool hat einen
  Kontakt dauerhaft geparkt, ohne Weg zurück. Der neue Knopf **hängende
  zurückholen** (nur sichtbar, wenn es welche gibt) löst das ohne Doppelversand:
  ein Kontakt mit erfolgreichem Send geht auf seinen letzten erfolgreichen Step, damit
  die Follow-up-Logik ihn wieder aufnimmt; nur wer nie etwas erhalten hat, geht zurück
  in die Warteschlange.
- **Ein abgelehnter Einstellungs-Patch sah aus wie ein erfolgreicher.** Die
  Fehlermeldung landete oben auf der Seite, der Speichern-Knopf steht unten — man
  scrollt weg und glaubt, es sei gespeichert. Beide Speichern-Knöpfe melden das
  Ergebnis jetzt direkt am Knopf, rot bei Fehler. Betrifft konkret den Fall
  `replyRateMinSample > replyRateWindow`, der genau so still liegengeblieben ist.

### Hinzugefügt

- **`POST /admin/requeue`** und `requeueStuck()` in `campaign.js`.
- **`REPLY_RATE_MATURITY_HOURS`** als Startwert, einstellbar unter `/settings`.
- `stats()` liefert zusätzlich `replyRateMinSample`, `replyRateMaturityHours`,
  `maturing` und `stuck`.
- **`test/guards.test.mjs`** — 21 Checks: Reifezeit-Filterung, die Bremse, die auf
  unreifen Sends nicht greift, und alle vier Requeue-Fälle.

### Wichtig zu wissen

- Eine Reply-Rate von 0 Prozent in den ersten 24 Stunden ist ab jetzt kein Grund zur
  Sorge und kein Grund zum Pausieren — sie ist der erwartete Zustand.

---

## [1.5.0] — 2026-08-20

Was nach der Antwort passiert. Vorher endete die Automatik beim Reply; jetzt wird
Ja von Nein unterschieden und in GHL sichtbar gemacht.

### Hinzugefügt

- **Ja/Nein-Erkennung im Inbound-Webhook.** Ein Ja löst die Detail-Nachricht aus,
  ein Nein wird respektiert und nicht weiterverfolgt.
- **Tags mit Kanal im Namen** — `cha08-sms-sent`, `cha08-sms-yes`, `cha08-sms-no`,
  `cha08-sms-replied`, `cha08-sms-opted-out`. Der Kanal steht im Tag, weil dieselbe
  Kampagne später auch über einen anderen Kanal laufen kann und die Auswertung
  sonst nicht mehr trennbar ist.
- **Knopf "Beschreibung speichern"** auf `/settings` samt Route, damit der Brief
  auch ohne einen Generator-Lauf erhalten bleibt.

---

## [1.4.0] — 2026-08-20

Bedienbarkeit. Scharfschaltung und Notbremse als Knopf, und der Admin-Key muss
nicht mehr auf jeder Seite eingegeben werden.

### Hinzugefügt

- **Login statt Key-Feld.** `POST /login` setzt ein HttpOnly-Cookie mit
  `SameSite=Lax` für 30 Tage. Das Cookie ist eine HMAC-signierte Ablaufzeit — kein
  Session-Store, und ein Neustart meldet niemanden ab. Der Vergleich läuft über
  `timingSafeEqual`, das `Secure`-Flag wird aus `x-forwarded-proto` entschieden,
  weil die Anfrage hinter dem Railway-Proxy intern per http ankommt.
  Der Header `x-admin-key` funktioniert unverändert weiter, damit curl und
  Automatisierung nichts merken.
- **Scharfschaltung und Notbremse** oben im Dashboard, mit Zwei-Klick-Bestätigung
  statt Browser-Dialog: der erste Klick entsichert, der zweite löst aus, nach fünf
  Sekunden sichert sich der Knopf selbst wieder. Der Freigabe-Knopf sagt, was er
  wirklich tut — im Testmodus "Freigeben (Testmodus)", live die Warnung, dass die
  erste echte SMS innerhalb von 30 Sekunden rausgeht.

### Geändert

- **`server.js` von rund 900 auf 250 Zeilen.** Die Seiten liegen jetzt in
  `src/pages/*.js`, `server.js` enthält nur noch Routen.
- **Kein Meta-Refresh mehr.** Der Reload läuft über JS und überspringt sich
  selbst, solange ein Eingabefeld Fokus oder Inhalt hat — die Seite löscht nicht
  mehr, was man gerade tippt.
- Alle drei Seiten laden ihre Daten mit einer Session von selbst und zeigen ohne
  Session eine Login-Karte.

### Sicherheit

- Der Key wanderte vorher bei jeder Aktion durch die Zwischenablage. Das ist nicht
  nur unbequem, es ist schlechter: ein Secret, das den ganzen Tag im Clipboard liegt,
  landet irgendwann im falschen Fenster.

---

## [1.3.0] — 2026-08-20

Die Nachrichten schreiben sich selbst. Kampagne einmal beschreiben, das Modell
liefert die Varianten — als Vorschlag, nicht als fait accompli.

### Hinzugefügt

- **Feld „Kampagne beschreiben" auf `/settings`.** Thema, Datum, Ort, Zielgruppe,
  Ziel. Dazu Sprache und Anzahl der Varianten pro Step. Ein Klick, und die Varianten
  stehen unten im Editor.
- **`src/generate.js`** — Anthropic Messages API mit erzwungenem Tool-Schema, damit das
  Ergebnis strukturiert zurückkommt statt aus Prosa geparst werden zu müssen.
- **Die Regeln stecken im System-Prompt**, nicht im Kopf des Betreibers: kein Link in
  der Erstnachricht, genau ein Ask mit Drei-Zeichen-Antwort, Opt-out im Klartext, Plain
  Text, 160 bis 300 Zeichen, `{{first_name}}` als einziger Platzhalter, und Varianz in
  der **Struktur** statt in einzelnen Wörtern — Wortsubstitution ist genau das, was
  Spam-Filter erkennen.
- **Modell wird automatisch bestimmt** über `GET /v1/models` (neuestes Sonnet), 24 Stunden
  gecacht. So bricht der Generator nicht, wenn Modellnamen sich ändern.
  `ANTHROPIC_MODEL` überschreibt.
- **IDs werden geslugt, mit Step-Prefix versehen und gegen bestehende dedupt** — aus
  „Frage zuerst" wird `s1-frage-zuerst`, bei Kollision `-2`.
- **`test/generate.test.mjs`** — 34 Checks gegen einen Mock-Anthropic: Modellauswahl,
  Cache, ID-Dedupe, Inhalt des Prompts, Grenzen der Anzahl, Fehlerfälle, und dass der
  Pool dabei unangetastet bleibt.

### Wichtig zu wissen

- **Der Generator speichert nichts.** Die Varianten landen als Vorschlag im Editor und
  sind mit „neu generiert" markiert. Erst „Nachrichten speichern" schreibt sie in die
  Datenbank. Bei Nachrichten an echte Kontakte gehört der letzte Blick einem Menschen.
- **In GHL ist dafür nichts einzustellen.** Es braucht nur `ANTHROPIC_API_KEY` in
  Railway. Ohne Key ist der Button deaktiviert und sagt das auch.
- Das Modell erfindet keine Platzhalter in eckigen Klammern. Fehlt ein Detail im Brief,
  formuliert es die Nachricht so, dass sie ohne dieses Detail funktioniert, und schreibt
  in `notes`, was gefehlt hat.

### Behoben

- Eine Escape-Ebene in der Statusmeldung des Generators lieferte einen echten Zeilenumbruch
  in ein Client-String-Literal und liess damit das komplette Inline-Script der
  Settings-Seite nicht mehr parsen. Ersetzt durch `String.fromCharCode(10)`.

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
