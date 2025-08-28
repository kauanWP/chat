// src/answer.js
import { generateText } from './groq-client.js';
import { buildPrompt } from './prompt-templates.js';

/**
 * Monta uma resposta curta localmente (fallback conciso) a partir dos trechos.
 */
function localConciseFallback(query, passages = []) {
  const top = passages.slice(0, 3);
  const firstSentences = top.map(p => {
    const s = p.text.replace(/\s+/g, ' ').trim();
    const m = s.match(/(.{20,200}?[\.!?])\s/);
    if (m && m[1]) return m[1].trim();
    return (s.slice(0, 160)).trim();
  }).filter(Boolean);

  const summaryParts = [];
  if (firstSentences.length > 0) {
    const words = firstSentences[0].split(/\s+/).slice(0, 10).join(' ');
    summaryParts.push(`Como fazer: ${words}...`);
  } else {
    summaryParts.push('Não encontrei instruções completas nos manuais.');
  }

  const steps = firstSentences.slice(0, 3).map((s, i) => `${i+1}. ${s}`);
  const answer = [summaryParts[0], ...steps].join('\n\n');

  const sources = Array.from(new Set(top.map(p => p.source).filter(Boolean))).slice(0, 3);
  return { answer: answer, sources };
}

/**
 * Tenta extrair um JSON do texto do modelo. Se falhar, cria um resumo curto.
 */
function parseModelOutput(text, passages = []) {
  if (!text) return null;

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last >= first) {
    const jsonPart = text.slice(first, last + 1);
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && typeof parsed.answer === 'string') {
        parsed.sources = Array.isArray(parsed.sources) ? parsed.sources.slice(0, 3) : [];
        return parsed;
      }
    } catch (err) {
      // segue para heurística
    }
  }

  const trimmed = text.trim();
  const parts = trimmed.split(/\n{2,}/).slice(0, 3).map(p => p.replace(/\s+/g, ' ').trim());
  const answer = parts.join('\n\n').slice(0, 600);
  const sourceMatches = [...trimmed.matchAll(/([A-Z0-9 \-_]{4,}\.pdf)/gi)].map(m => m[0]);
  const sources = Array.from(new Set(sourceMatches)).slice(0, 3);

  return { answer: answer, sources };
}

/**
 * Extrai uma sentença curta representativa de um trecho.
 */
function extractShortSentenceFromText(s = '') {
  if (!s) return null;
  const txt = s.replace(/\s+/g, ' ').trim();
  const m = txt.match(/(.{20,220}?[\.!?])(\s|$)/);
  if (m && m[1]) return m[1].trim();
  // fallback: pega até 120 chars
  return txt.slice(0, 120).trim();
}

/**
 * Gera até N passos a partir dos passages (heurística).
 * Retorna array com strings CURTAS (sem numerar).
 */
function generateStepsFromPassages(passages = [], maxSteps = 3) {
  const top = passages.slice(0, maxSteps);
  const steps = [];
  for (const p of top) {
    const s = extractShortSentenceFromText(p.text || '');
    if (s) steps.push(s);
    if (steps.length >= maxSteps) break;
  }
  return steps;
}

/**
 * Garante que a resposta contenha 1 frase-resumo + até 3 passos (se possível).
 * Se parsedAnswer já tem passos (procura por "1." ou por parágrafos), respeita.
 */
function ensureAnswerHasSteps(parsedAnswer = { answer: '' }, passages = []) {
  let ans = String(parsedAnswer.answer || '').trim();

  // já tem múltiplos parágrafos? então assume que tem passos
  const paragraphCount = (ans.match(/\n{2,}/g) || []).length + 1;
  const hasNumbered = /\b1\.\s/.test(ans);

  if (paragraphCount > 1 || hasNumbered) {
    // já ok — retorna como está (apenas corta espaços e remove fontes embutidas)
    ans = ans.replace(/\n?\s*Fonte(s)?:[\s\S]*$/i, '').trim();
    return { answer: ans, sources: parsedAnswer.sources || [] };
  }

  // se temos apenas uma linha e temos passages, gera steps heurísticos
  const steps = generateStepsFromPassages(passages, 3);
  if (steps.length === 0) {
    // nada a acrescentar
    ans = ans.replace(/\n?\s*Fonte(s)?:[\s\S]*$/i, '').trim();
    return { answer: ans, sources: parsedAnswer.sources || [] };
  }

  // tenta extrair uma frase-resumo curta do ans; se não existir, cria a partir do primeiro step
  const firstSentenceMatch = ans.match(/(.{10,200}?[\.!?])(\s|$)/);
  let summary = firstSentenceMatch && firstSentenceMatch[1] ? firstSentenceMatch[1].trim() : null;
  if (!summary) {
    summary = steps[0].split(/(?<=[.?!])\s+/)[0] || steps[0];
  }

  // monta resposta com quebras duplas (o frontend usa \n\n pra separar bolhas)
  const numbered = steps.map((s, i) => `${i+1}. ${s}`);
  const final = [summary, ...numbered].join('\n\n');

  const sources = parsedAnswer.sources && parsedAnswer.sources.length ? parsedAnswer.sources.slice(0,3) : [];
  return { answer: final, sources };
}

export async function buildAnswer(query, passages = []) {
  if (!passages || passages.length === 0) {
    return {
      answer: 'Não encontrei nada nos manuais relacionado a essa pergunta.',
      sources: []
    };
  }

  const top = passages.slice(0, 3);
  const defaultSources = Array.from(new Set(top.map(p => p.source))).slice(0, 3);

  const prompt = buildPrompt({ query, passages: top });

  const params = {
    max_new_tokens: Number(process.env.GROQ_MAX_TOKENS) || 256,
    temperature: Number(process.env.GROQ_TEMPERATURE || 0.0),
    top_p: Number(process.env.GROQ_TOP_P || 0.9)
  };

  try {
    const model = process.env.GROQ_MODEL;
    const generated = await generateText({ model, inputs: prompt, parameters: params });
    const raw = String(generated || '').trim();

    let parsed = parseModelOutput(raw, top);
    if (!parsed || !parsed.answer) {
      // modelo não útil: tenta fallback local conciso (que já produz steps)
      console.warn('⚠️ buildAnswer: modelo devolveu vazio/mal formatado — usando fallback conciso.');
      return localConciseFallback(query, top);
    }

    // garante fontes se modelo não trouxe
    if ((!parsed.sources || parsed.sources.length === 0) && defaultSources.length) {
      parsed.sources = defaultSources;
    }

    // assegura que exista resumo + passos (se possível)
    const ensured = ensureAnswerHasSteps(parsed, top);

    // limites de segurança
    let outAnswer = String(ensured.answer || '').trim();
    if (outAnswer.length > 1600) outAnswer = outAnswer.slice(0, 1600) + '...';

    const outSources = Array.isArray(ensured.sources) && ensured.sources.length ? ensured.sources.slice(0,3) : defaultSources;
    return { answer: outAnswer, sources: outSources };
  } catch (err) {
    console.warn('⚠️ Falha na geração via GROQ — usando fallback local:', err.message || err);
    return localConciseFallback(query, top);
  }
}
