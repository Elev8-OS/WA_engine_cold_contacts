// Mock-Anthropic für die Tests. Kein Teil des Deployments.
import express from 'express';

export function startMockAnthropic(port = 4477) {
  const state = {
    calls: [],
    models: [
      { id: 'claude-haiku-4-5-20260101', type: 'model' },
      { id: 'claude-sonnet-4-5-20260101', type: 'model' },
      { id: 'claude-opus-4-5-20260101', type: 'model' },
    ],
    modelsFail: false,
    emptyVariants: false,
    // Was das "Modell" zurückgibt.
    variants: [
      { step: 1, label: 'Kontext zuerst', body: 'Hi {{first_name}}, Reto here. Reply YES for details. Reply OUT to stop.' },
      { step: 1, label: 'Frage zuerst!! *bold*', body: 'Hi {{first_name}}, still running villas? Reply 1 or 2. OUT to stop.' },
      { step: 1, label: 'Frage zuerst!! *bold*', body: 'Second one with the same label to test dedupe. OUT to stop.' },
      { step: 2, label: 'In oder out', body: '{{first_name}}, in or out? Reply IN or OUT.' },
      { step: 1, label: 'Leerer Text', body: '   ' },
    ],
    notes: 'Datum fehlte im Brief, deshalb ohne Datum formuliert.',
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/v1/models', (req, res) => {
    state.calls.push({ path: '/v1/models', key: req.get('x-api-key') });
    if (state.modelsFail) return res.status(401).json({ error: { message: 'invalid x-api-key' } });
    res.json({ data: state.models });
  });

  app.post('/v1/messages', (req, res) => {
    state.calls.push({
      path: '/v1/messages',
      key: req.get('x-api-key'),
      version: req.get('anthropic-version'),
      model: req.body?.model,
      system: req.body?.system,
      tools: (req.body?.tools || []).map((t) => t.name),
      toolChoice: req.body?.tool_choice,
      userPrompt: req.body?.messages?.[0]?.content,
    });
    res.json({
      id: 'msg_mock',
      content: [
        {
          type: 'tool_use',
          name: 'emit_variants',
          input: state.emptyVariants
            ? { variants: [] }
            : { variants: state.variants, notes: state.notes },
        },
      ],
      usage: { input_tokens: 500, output_tokens: 900 },
    });
  });

  app.use((req, res) => res.status(404).json({ error: { message: `no mock for ${req.path}` } }));

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, state }));
  });
}
