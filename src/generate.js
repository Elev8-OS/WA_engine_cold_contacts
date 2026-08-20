import { config } from './config.js';
import { getState, setState, logEvent } from './db.js';

/**
 * Varianten-Generator.
 *
 * Du beschreibst die Kampagne einmal, das Modell schreibt die Varianten.
 * Wichtig: das Ergebnis wird NICHT gespeichert. Es landet als Vorschlag im
 * Editor, du liest drüber, änderst und speicherst selbst. Bei Nachrichten an
 * echte Kontakte gehört der letzte Blick einem Menschen.
 */

const SYSTEM_PROMPT = `Du schreibst SMS-Varianten für Kaltkontakt-Kampagnen, die über GoHighLevel versendet werden.

ZIEL JEDER NACHRICHT
Der Empfänger soll ANTWORTEN. Eine Antwort öffnet das Konversationsfenster, signalisiert dem Carrier eine gewollte Konversation und schützt die Absendernummer. Eine Nachricht, die niemand beantwortet, ist schlechter als keine Nachricht.

HARTE REGELN
1. Kein Link in der Erstnachricht. Ein Link ohne vorherige Konversation ist das klassische Spam-Muster. Der Link kommt erst, wenn geantwortet wurde.
2. Genau ein Ask pro Nachricht, und die Antwort muss in drei Zeichen möglich sein: "YES", "1", "SEND", "IN".
3. Jede Nachricht endet mit einer Opt-out-Möglichkeit im Klartext, z. B. "Reply OUT to stop". Ein "OUT" ist harmlos, ein Block kostet Reputation.
4. Plain Text. Keine Markdown-Sternchen, keine Formatierung, keine Links, keine Emojis (maximal eines, wenn es wirklich passt).
5. Kein CAPS-Block, keine Ausrufezeichen-Ketten, kein "Dear Sir/Madam".
6. Ziel 160 bis 300 Zeichen. Ein SMS-Segment sind 160 Zeichen; über 320 wird es teuer und wirkt wie Werbung.
7. Der Platzhalter für den Vornamen ist genau {{first_name}} — mit zwei Klammern, nichts anderes. Nutze ihn, aber nicht mehr als einmal pro Nachricht.
8. Keine Platzhalter in eckigen Klammern erfinden. Alles, was der Brief nicht hergibt, lässt du weg statt es zu markieren. Fehlt ein Detail, formuliere die Nachricht so, dass sie ohne dieses Detail funktioniert.

VARIANZ
Die Varianten müssen sich in der STRUKTUR unterscheiden, nicht in einzelnen Wörtern. Spam-Erkennung erkennt Wortsubstitution sofort. Nutze pro Variante einen anderen Einstieg und einen anderen Ask, zum Beispiel:
- Kontext zuerst: wo man sich begegnet ist, dann die Einladung
- Frage zuerst: eine echte Frage zur Situation des Empfängers, dann der Grund
- Zahl zuerst: die konkrete Erkenntnis oder Zahl als Haken
- Kurz und direkt: drei Sätze, kein Aufwärmen
- Zwei-Tasten-Antwort: "Reply 1 for details, 2 if the timing is off"

STEPS
step 1 = Erstnachricht. Der Empfänger hat noch nichts bekommen.
step 2 = Follow-up nach 48 Stunden ohne Antwort. Muss anerkennen, dass schon eine Nachricht kam, darf nicht drängen, und braucht einen expliziten Ausweg ("OUT und ich nehme dich von der Liste"). Genau ein Follow-up, danach Stille — schreibe niemals so, als käme noch etwas.

TON
Direkt, konkret, ohne Marketing-Sprache. Keine Floskeln wie "exciting opportunity", "don't miss out", "revolutionary". Schreib wie ein Mensch, der den Empfänger kennt und dessen Zeit respektiert. Wenn der Brief eine Branche nennt, benutze deren Wörter.

SPRACHE
Schreibe in der Sprache, die im Brief verlangt wird. Ohne Angabe: Englisch.`;

const TOOL = {
  name: 'emit_variants',
  description: 'Gibt die fertigen SMS-Varianten zurück.',
  input_schema: {
    type: 'object',
    properties: {
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            step: { type: 'integer', enum: [1, 2], description: '1 = Erstnachricht, 2 = Follow-up' },
            label: {
              type: 'string',
              description: 'Kurzer Name des Ansatzes, z. B. "Frage zuerst". Maximal 40 Zeichen.',
            },
            body: { type: 'string', description: 'Der fertige SMS-Text.' },
          },
          required: ['step', 'label', 'body'],
        },
      },
      notes: {
        type: 'string',
        description:
          'Optional: was im Brief gefehlt hat oder worauf der Betreiber vor dem Versand achten sollte. Ein bis drei Sätze.',
      },
    },
    required: ['variants'],
  },
};

export function getBrief() {
  return {
    brief: getState('campaign_brief', ''),
    language: getState('campaign_language', 'Englisch'),
    countStep1: Number(getState('campaign_count_step1', '4')),
    countStep2: Number(getState('campaign_count_step2', '3')),
    lastGeneratedAt: Number(getState('campaign_generated_at', '0')) || null,
    lastModel: getState('campaign_model', ''),
    lastNotes: getState('campaign_notes', ''),
    enabled: Boolean(config.ai.apiKey),
  };
}

async function anthropic(path, { method = 'GET', body } = {}) {
  const res = await fetch(config.ai.baseUrl + path, {
    method,
    headers: {
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = payload?.error?.message || JSON.stringify(payload).slice(0, 300);
    throw new Error(`Anthropic ${res.status}: ${msg}`);
  }
  return payload;
}

/**
 * Modell bestimmen. Ohne ANTHROPIC_MODEL wird die Modell-Liste geholt und das
 * neueste Sonnet genommen — so bricht der Generator nicht, wenn Modellnamen
 * sich ändern.
 */
export async function resolveModel() {
  if (config.ai.model) return config.ai.model;

  const cached = getState('ai_model_resolved', '');
  const cachedAt = Number(getState('ai_model_resolved_at', '0'));
  if (cached && Date.now() - cachedAt < 24 * 3600 * 1000) return cached;

  const list = await anthropic('/v1/models?limit=50');
  const ids = (list?.data || []).map((m) => m.id).filter(Boolean);
  const pick =
    ids.find((id) => id.includes('sonnet')) ||
    ids.find((id) => id.includes('opus')) ||
    ids[0];
  if (!pick) throw new Error('Anthropic hat keine Modelle zurückgegeben');

  setState('ai_model_resolved', pick);
  setState('ai_model_resolved_at', String(Date.now()));
  logEvent('info', `Modell für den Generator: ${pick}`);
  return pick;
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' })[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

/** IDs bauen, die zum Editor passen und nicht mit bestehenden kollidieren. */
function assignIds(variants, existingIds = []) {
  const taken = new Set(existingIds);
  return variants.map((v, i) => {
    const step = v.step === 2 ? 2 : 1;
    const base = `s${step}-${slug(v.label) || 'variant'}`;
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    return {
      id,
      step,
      label: String(v.label || '').slice(0, 60),
      body: String(v.body || '').trim(),
      active: true,
      chars: String(v.body || '').trim().length,
      generated: true,
      order: i,
    };
  });
}

/**
 * Varianten erzeugen. Speichert nichts im Pool — nur den Brief, damit er beim
 * nächsten Öffnen der Seite noch da ist.
 */
export async function generateVariants({
  brief,
  language = 'Englisch',
  countStep1 = 4,
  countStep2 = 3,
  existingIds = [],
}) {
  if (!config.ai.apiKey) {
    throw new Error('ANTHROPIC_API_KEY fehlt — Generator ist aus. Key in Railway setzen.');
  }
  const text = String(brief || '').trim();
  if (text.length < 30) {
    throw new Error(
      'Der Brief ist zu kurz. Beschreibe Thema, Datum, Ort, Zielgruppe und was du erreichen willst — mindestens ein paar Sätze.'
    );
  }
  const n1 = Math.min(8, Math.max(1, Number(countStep1) || 4));
  const n2 = Math.min(8, Math.max(0, Number(countStep2) || 0));

  setState('campaign_brief', text);
  setState('campaign_language', language);
  setState('campaign_count_step1', String(n1));
  setState('campaign_count_step2', String(n2));

  const model = await resolveModel();

  const userPrompt = `Schreibe ${n1} Varianten für step 1${n2 > 0 ? ` und ${n2} Varianten für step 2` : ' und keine für step 2'}.

Sprache der Nachrichten: ${language}

BRIEF DES BETREIBERS:
${text}

Gib die Varianten über das Tool emit_variants zurück. Jede step-1-Variante muss einen anderen strukturellen Ansatz haben — nicht denselben Text mit getauschten Wörtern.`;

  const res = await anthropic('/v1/messages', {
    method: 'POST',
    body: {
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'emit_variants' },
      messages: [{ role: 'user', content: userPrompt }],
    },
  });

  const block = (res?.content || []).find((c) => c.type === 'tool_use' && c.name === 'emit_variants');
  if (!block?.input?.variants?.length) {
    throw new Error('Das Modell hat keine Varianten zurückgegeben. Nochmal versuchen.');
  }

  const raw = block.input.variants.filter((v) => String(v.body || '').trim().length > 0);
  const variants = assignIds(raw, existingIds);
  const notes = String(block.input.notes || '').slice(0, 600);

  setState('campaign_generated_at', String(Date.now()));
  setState('campaign_model', model);
  setState('campaign_notes', notes);

  const s1 = variants.filter((v) => v.step === 1).length;
  const s2 = variants.filter((v) => v.step === 2).length;
  logEvent('info', `Generator: ${s1} Varianten step 1, ${s2} step 2 (${model})`);

  return {
    variants,
    notes,
    model,
    usage: res?.usage || null,
    warning:
      'Vorschlag, nicht gespeichert. Lies jeden Text, bevor du speicherst — danach geht er an echte Empfänger.',
  };
}
