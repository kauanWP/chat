// src/server.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

import { loadIndex, search } from './search.js';
import { rerank } from './rerank.js';
import { buildAnswer } from './answer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple API key check (set API_KEY in Render/env or .env)
function checkAuth(req, res, next) {
  const apiKey = process.env.API_KEY || '';
  if (!apiKey) return next(); // se não tiver configurado, libera (dev)
  const got = req.get('x-api-key') || req.query.key || req.body.key;
  if (got && got === apiKey) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/health', (req, res) => res.json({ ok: true }));

// POST /api/query { question: "..." }
app.post('/api/query', checkAuth, async (req, res) => {
  try {
    const q = (req.body?.question || req.body?.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Missing question' });

    // busca inicial
    const rawHits = search(q, 8); // pool maior para rerank
    const topk = Number(process.env.RERANK_TOPK) || 3;

    // rerank pode ser async e usa LLM ou heurística
    const hits = await rerank(q, rawHits, topk);
    if (!hits || hits.length === 0) {
      return res.json({ answer: 'Não encontrei trechos relevantes nos manuais.', sources: [] });
    }

    const { answer, sources } = await buildAnswer(q, hits);
    return res.json({ answer, sources: Array.isArray(sources) ? Array.from(new Set(sources)) : [] });
  } catch (err) {
    console.error('API /api/query error:', err);
    return res.status(500).json({ error: 'Erro interno', details: String(err.message || err) });
  }
});

// serve SPA fallback (opcional)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 6000;

(async () => {
  try {
    const { count } = loadIndex();
    console.log(`Índice carregado com ${count} chunks.`);
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (e) {
    console.error('Erro ao iniciar: rode "npm run ingest" primeiro ou confirme store/base.json:', e);
    process.exit(1);
  }
})();
