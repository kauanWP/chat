// src/rerank.js
import { generateText } from './groq-client.js';

/**
 * Pequena tokenização pra heurística (evita dependência circular com search.js).
 */
function simpleTokens(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúãõç\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Heurística barata: sobreposição de tokens entre query e snippet/text.
 * Usa tie-breaker pelo score original se disponível.
 */
function heuristicRank(query, hits = [], k = 3) {
  const qtokens = new Set(simpleTokens(query));
  const scored = hits.map(h => {
    const text = (h.snippet || h.text || '').slice(0, 800);
    const tokens = simpleTokens(text);
    let common = 0;
    for (const t of tokens) if (qtokens.has(t)) common++;
    const overlap = common / Math.max(1, tokens.length);
    // Normalize original score a bit (if present) to break ties: try to coerce number
    const orig = Number(h.score) || 0;
    const score = overlap + (orig * 0.001);
    return { hit: h, score, overlap, orig };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(s => s.hit);
}

/**
 * Chama o modelo para reranking: pede JSON com topIds.
 * Caso falhe, volta para heuristicRank.
 */
export async function rerank(query, hits = [], k = 3) {
  if (!Array.isArray(hits) || hits.length === 0) return [];

  // Se poucos hits, retorna direto
  if (hits.length <= k) return hits.slice(0, k);

  // Se RERANK não ativado, usa heurística
  if (process.env.RERANK_ENABLED !== '1') {
    if (process.env.RERANK_DEBUG) console.log('[RERANK] disabled — using heuristic');
    return heuristicRank(query, hits, k);
  }

  // Monta payload curto dos hits (id, source, snippet)
  const list = hits.slice(0, 12).map((h, i) => {
    return `${i + 1}. id:${h.id} source:"${h.source || 'unknown'}" score:${(h.score ?? '').toString().slice(0,8)}\n   snippet: "${(h.snippet || (h.text || '')).slice(0,350).replace(/\n/g, ' ')}"`;
  }).join('\n\n');

  const maxTokens = Number(process.env.RERANK_MAX_TOKENS) || 256;
  const model = process.env.RERANK_MODEL || process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

  const prompt =
`Você é um avaliador de relevância técnico. Com base na pergunta e nos trechos abaixo, escolha os até ${k} IDs que melhor respondem a pergunta. Seja conservador: escolha apenas os trechos que realmente contém informação relevante para responder a pergunta. 
RETORNE APENAS UM JSON VÁLIDO no formato:
{ "topIds": [<id>, ...] }

Pergunta:
${query}

Trechos (id, source, snippet):
${list}

Observação: responda SOMENTE com o JSON (sem texto extra).`;

  try {
    if (process.env.RERANK_DEBUG) console.log('[RERANK] prompt len:', prompt.length, 'model:', model);

    const generated = await generateText({
      model,
      inputs: prompt,
      parameters: {
        max_new_tokens: maxTokens,
        temperature: 0.0,
        top_p: 0.95
      }
    });

    if (!generated || !String(generated).trim()) {
      if (process.env.RERANK_DEBUG) console.warn('[RERANK] empty response from model, falling back');
      return heuristicRank(query, hits, k);
    }

    const text = String(generated);
    // Tenta extrair o JSON: pega o primeiro "{" e o último "}"
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    let jsonPart = null;
    if (first !== -1 && last !== -1 && last >= first) {
      jsonPart = text.slice(first, last + 1);
    } else {
      jsonPart = text.trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonPart);
    } catch (err) {
      // Às vezes o modelo devolve aspas estranhas; tenta limpar linhas antes de achar array
      const match = text.match(/\[ *([0-9, \n\r]*) *\]/);
      if (match) {
        parsed = { topIds: match[0] };
      } else {
        if (process.env.RERANK_DEBUG) {
          console.warn('[RERANK] falha ao parsear JSON do reranker:', err.message);
          console.warn('[RERANK] raw:', text);
        }
        return heuristicRank(query, hits, k);
      }
    }

    const topIds = Array.isArray(parsed.topIds) ? parsed.topIds.map(String) : [];
    if (!topIds.length) {
      if (process.env.RERANK_DEBUG) console.warn('[RERANK] parsed JSON sem topIds. fallback.');
      return heuristicRank(query, hits, k);
    }

    // Mapeia back para os hits, mantendo a ordem do topIds
    const idToHit = new Map(hits.map(h => [String(h.id), h]));
    const selected = [];
    for (const tid of topIds) {
      const h = idToHit.get(String(tid));
      if (h) selected.push(h);
      if (selected.length >= k) break;
    }

    // Se resultou vazio, fallback
    if (selected.length === 0) return heuristicRank(query, hits, k);

    if (process.env.RERANK_DEBUG) {
      console.log('[RERANK] selected ids:', selected.map(s => s.id));
    }
    return selected;
  } catch (err) {
    if (process.env.RERANK_DEBUG) console.error('[RERANK] erro no rerank:', err);
    return heuristicRank(query, hits, k);
  }
}
