// Mock-GHL für die Tests. Kein Teil des Deployments.
import express from 'express';

export function startMockGhl(port = 4444) {
  const state = {
    smartListMembers: [
      { id: 'ct1', firstName: 'Made', phone: '+62811111111', tags: ['cha08-invite'] },
      { id: 'ct2', firstName: 'Sarah', phone: '+62822222222', tags: ['cha08-invite'] },
      { id: 'ct3', firstName: 'Tom', phone: '+62833333333', tags: ['other'] },
    ],
    searchFails: false,
    smartListsFail: false,
    sent: [],
    tagged: [],
  };

  const app = express();
  app.use(express.json());

  app.get('/contacts/smart-lists', (req, res) => {
    if (state.smartListsFail) return res.status(404).json({ message: 'not found' });
    res.json({
      smartLists: [
        { id: 'sl1', name: 'Bali Villa Connect Besucher', count: state.smartListMembers.length },
        { id: 'sl2', name: 'Hot Leads', count: 12 },
      ],
    });
  });

  app.get('/contacts/smart-lists/:id/contacts', (req, res) => {
    if (state.smartListsFail) return res.status(404).json({ message: 'not found' });
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    res.json({ contacts: state.smartListMembers.slice(offset, offset + limit) });
  });

  app.post('/contacts/search', (req, res) => {
    if (state.searchFails) return res.status(422).json({ message: 'filters invalid' });
    const filters = req.body?.filters || [];
    const tag = filters.find((f) => f.field === 'tags')?.value;
    const list = tag
      ? state.smartListMembers.filter((c) => c.tags.includes(tag))
      : state.smartListMembers;
    res.json({ contacts: list, total: list.length });
  });

  app.get('/contacts/', (req, res) => {
    const limit = Number(req.query.limit || 100);
    const all = state.smartListMembers;
    const startIdx = req.query.startAfterId
      ? all.findIndex((c) => c.id === req.query.startAfterId) + 1
      : 0;
    const batch = all.slice(startIdx, startIdx + limit);
    res.json({
      contacts: batch,
      meta: { startAfterId: batch.at(-1)?.id, startAfter: 1 },
    });
  });

  app.get('/locations/:loc/tags', (req, res) => {
    res.json({
      tags: [
        { id: 't2', name: 'other', locationId: req.params.loc },
        { id: 't1', name: 'cha08-invite', locationId: req.params.loc },
      ],
    });
  });

  app.post('/conversations/messages', (req, res) => {
    state.sent.push(req.body);
    res.json({ conversationId: 'cv1', messageId: 'msg' + state.sent.length });
  });

  app.post('/contacts/:id/tags', (req, res) => {
    state.tagged.push({ id: req.params.id, tags: req.body?.tags });
    res.json({ tags: req.body?.tags });
  });

  app.use((req, res) => res.status(404).json({ message: `no mock for ${req.method} ${req.path}` }));

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, state }));
  });
}
