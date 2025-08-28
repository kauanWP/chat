// src/answer.js
import { generateText } from './groq-client.js';
import { buildPrompt } from './prompt-templates.js';

/**
 * Monta uma resposta curta localmente (fallback conciso) a partir dos trechos.
 * Estratégia simples e determinística: pega a primeira frase de até 3 trechos e organiza em 1 frase-resumo + até 3 passos.
 */
function localConciseFallback(query, passages = []) {
  const top = passages.slice(0, 3);
  const firstSentences = top.map(p => {
    // pega até o primeiro ponto final ou 160 chars
    const s = p.text.replace(/\s+/g, ' ').trim();
    const m = s.match(/(.{20,200}?[\.!?])\s/);
    if (m && m[1]) return m[1].trim();
    // se não encontrar pontuação, corta
    return (s.slice(0, 160)).trim();
  }).filter(Boolean);

  // construir frase-resumo concisa (combinar assunto + verbo)
  const summaryParts = [];
  if (firstSentences.length > 0) {
    // tenta extrair sujeito curto do primeiro trecho (heurística: primeiros 6-10 words)
    const words = firstSentences[0].split(/\s+/).slice(0, 10).join(' ');
    summaryParts.push(`Como fazer: ${words}...`);
  } else {
    summaryParts.push('Não encontrei instruções completas nos manuais.');
  }

  // Passos: usa uma sentença de cada trecho como passo
  const steps = firstSentences.slice(0, 3).map((s, i) => `${i+1}. ${s}`);
  const answer = [summaryParts[0], ...steps].join('\n\n');

  const sources = Array.from(new Set(top.map(p => p.source).filter(Boolean))).slice(0, 3);
  return { answer: answer, sources };
}

/**
 * post-processa resposta textual do modelo: tenta extrair JSON; se não, converte em resposta curta.
 */
function parseModelOutput(text, passages = []) {
  if (!text) return null;

  // tenta extrair JSON do texto
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last >= first) {
    const jsonPart = text.slice(first, last + 1);
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && typeof parsed.answer === 'string') {
        // garantia: sources coerentes
        parsed.sources = Array.isArray(parsed.sources) ? parsed.sources.slice(0, 3) : [];
        return parsed;
      }
    } catch (err) {
      // ignora e tenta heurística abaixo
    }
  }

  // Se não achou JSON: tenta achar "Fontes:" e extrair; e cria resumo curto
  // Limita ao máximo 600 chars antes de retornar
  const trimmed = text.trim();
  // heurística: pega primeiras 3 parágrafos curtos
  const parts = trimmed.split(/\n{2,}/).slice(0, 3).map(p => p.replace(/\s+/g, ' ').trim());
  const answer = parts.join('\n\n').slice(0, 600);
  // tenta extrair fontes nominais (nomes de PDF)
  const sourceMatches = [...trimmed.matchAll(/([A-Z0-9 \-_]{4,}\.pdf)/gi)].map(m => m[0]);
  const sources = Array.from(new Set(sourceMatches)).slice(0, 3);

  return { answer: answer, sources };
}

export async function buildAnswer(query, passages = []) {
  if (!passages || passages.length === 0) {
    return {
      answer: 'Não encontrei nada nos manuais relacionado a essa pergunta.',
      sources: []
    };
  }

  // Usa só os top 3 trechos (defensivo)
  const top = passages.slice(0, 3);
  const sources = Array.from(new Set(top.map(p => p.source))).slice(0, 3);

  // Monta prompt controlado (pede JSON)
  const prompt = buildPrompt({ query, passages: top });

  // Params conservadores para respostas curtas e determinísticas
  const params = {
    max_new_tokens: Number(process.env.GROQ_MAX_TOKENS) || 256,
    temperature: Number(process.env.GROQ_TEMPERATURE || 0.0),
    top_p: Number(process.env.GROQ_TOP_P || 0.9)
  };

  try {
    const model = process.env.GROQ_MODEL;
    const generated = await generateText({ model, inputs: prompt, parameters: params });
    const raw = String(generated || '').trim();

    // tenta extrair JSON ou parse
    const parsed = parseModelOutput(raw, top);
    if (parsed && parsed.answer) {
      // garante que fontes existam; se não vierem, anexa as fontes conhecidas
      if ((!parsed.sources || parsed.sources.length === 0) && sources.length) {
        parsed.sources = sources;
      }
      // trim answer e garantir comprimento
      parsed.answer = parsed.answer.trim();
      if (parsed.answer.length > 1200) parsed.answer = parsed.answer.slice(0, 1200) + '...';

      return { answer: parsed.answer, sources: parsed.sources || [] };
    }

    // Se o modelo gerou vazio ou formatou mal, fallback local conciso
    console.warn('⚠️ buildAnswer: resposta do modelo mal formatada ou vazia — usando fallback conciso.');
    return localConciseFallback(query, top);
  } catch (err) {
    console.warn('⚠️ Falha na geração via GROQ — usando fallback local:', err.message || err);
    return localConciseFallback(query, top);
  }
}
