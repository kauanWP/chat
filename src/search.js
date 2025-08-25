// src/search.js
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bm25 from 'wink-bm25-text-search';
import nlpUtils from 'wink-nlp-utils';
import util from 'util';

// Caminhos
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORE_FILE = join(__dirname, '..', 'store', 'base.json');

let index = null;
let documents = [];
let idMap = new Map();

/**
 * Preprocessamento: normaliza e quebra em tokens.
 */
function prep(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  return nlpUtils.string
    .removeExtraSpaces(
      nlpUtils.string.lowerCase(nlpUtils.string.removePunctuations(text))
    )
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Carrega índice e prepara dados auxiliares para fallback.
 */
export function loadIndex() {
  if (!fs.existsSync(STORE_FILE)) {
    throw new Error(
      `Arquivo de índice não encontrado: ${STORE_FILE}. Rode "npm run ingest" primeiro.`
    );
  }

  const raw = fs.readFileSync(STORE_FILE, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Falha ao parsear ${STORE_FILE}: ${err.message}`);
  }

  const rawDocs = Array.isArray(parsed.docs) ? parsed.docs : [];
  const filtered = [];

  for (let i = 0; i < rawDocs.length; i++) {
    const d = rawDocs[i];
    if (!d || typeof d !== 'object') continue;
    if (!d.text || typeof d.text !== 'string' || !d.text.trim()) continue;
    if (d.id == null) d.id = i + 1;
    d._tokens = prep(d.text);
    filtered.push(d);
  }

  const removed = rawDocs.length - filtered.length;
  if (removed > 0) {
    console.warn(
      `⚠️  loadIndex: ${removed} chunks inválidos removidos (sem texto ou malformados).`
    );
  }

  documents = filtered;
  idMap = new Map(documents.map((d) => [String(d.id), d]));

  // Inicializa BM25
  index = bm25();
  index.defineConfig({ fldWeights: { text: 1 } });
  index.definePrepTasks([prep]);

  for (const d of documents) {
    try {
      index.addDoc({ text: d.text, source: d.source }, String(d.id));
    } catch (err) {
      console.warn(
        `⚠️  loadIndex: falha ao adicionar doc id=${d.id} (${d.source || 'unknown'}): ${err.message}`
      );
    }
  }

  index.consolidate();
  return { count: documents.length };
}

/**
 * Normaliza resultados crus do BM25 para um formato estável.
 */
function normalizeResults(results) {
  return results
    .map((r) => {
      if (!r) return null;

      // possíveis formatos
      const rid =
        r.id ??
        r.docId ??
        r.docIdStr ??
        r.documentId ??
        (Array.isArray(r) ? r[0] : undefined);

      if (rid == null) return null;

      const key = String(rid);
      const doc = idMap.get(key);
      if (!doc) return null;

      const score =
        r.score ??
        (Array.isArray(r) && r.length > 1 ? r[1] : null) ??
        null;

      return { ...doc, score };
    })
    .filter(Boolean);
}

/**
 * Fallback: pontua docs por número de tokens em comum (interseção).
 */
function fallbackScore(queryTokens, k = 5) {
  if (!queryTokens.length) return [];
  const qset = new Set(queryTokens);
  const scored = documents
    .map((d) => {
      const docTokens = Array.isArray(d._tokens) ? d._tokens : prep(d.text || '');
      let common = 0;
      for (const t of docTokens) if (qset.has(t)) common++;
      const score = common / Math.max(1, docTokens.length);
      return { ...d, score };
    })
    .filter((d) => d.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Busca principal: tenta BM25 e, se falhar, usa fallback tokenizado.
 */
export function search(query, k = 5) {
  if (!index) throw new Error('Índice não carregado. Chame loadIndex() primeiro.');
  if (!query || typeof query !== 'string') return [];

  const raw = index.search(query);

  if (process.env.DEBUG_SEARCH) {
    console.log('[DEBUG_SEARCH] raw results:', util.inspect(raw, { depth: 2 }));
  }

  const hits = normalizeResults(raw).slice(0, k);

  if (hits.length > 0) return hits;

  console.warn('search: todos os hits válidos foram pulados. Executando fallback por tokens.');
  const qtokens = prep(query);
  return fallbackScore(qtokens, k);
}

/**
 * Recupera docs por ids.
 */
export function getByIds(ids = []) {
  if (!Array.isArray(ids)) return [];
  const s = new Set(ids.map((x) => String(x)));
  return documents.filter((d) => s.has(String(d.id)));
}
