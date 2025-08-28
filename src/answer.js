import { generateText } from 'ai';
import { buildPrompt } from './prompt.js';

/**
 * Gera um fallback conciso se o modelo não retornar nada
 */
function localConciseFallback(query, passages = []) {
  const top = passages.slice(0, 2);
  const joined = top.map(p => p.text).join(' ');
  return {
    answer: `Não encontrei uma resposta bem estruturada, mas os manuais mencionam: ${joined}`,
    sources: top.map(p => p.source)
  };
}

/**
 * Gera alguns passos automaticamente a partir dos trechos, se não houver steps
 */
function generateStepsFromPassages(passages = [], max = 3) {
  return passages
    .flatMap(p => p.text.split(/[\.\n]+/))
    .map(s => s.trim())
    .filter(s => s.length > 10)
    .slice(0, max);
}

/**
 * Tenta interpretar a saída crua do modelo como JSON
 */
function parseModelOutput(output, passages) {
  try {
    return JSON.parse(output);
  } catch {
    // se não for JSON, devolve como string crua
    return { answer: output, sources: passages.map(p => p.source) };
  }
}

/**
 * Normaliza a resposta para JSON estruturado:
 *  - intro: resumo curto
 *  - steps: lista de passos curtos
 *  - extra: observações finais
 */
function normalizeAnswer(parsedAnswer = { answer: '' }, passages = []) {
  const raw = String(parsedAnswer.answer || '').trim();

  const sources = parsedAnswer.sources || [];

  // quebra em linhas
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);

  let intro = '';
  const steps = [];
  let extra = '';

  for (const line of lines) {
    if (/^\d+[\.\)]\s+/.test(line) || line.startsWith('- ') || line.startsWith('•')) {
      steps.push(line.replace(/^\d+[\.\)]\s+|^- |^•\s*/, '').trim());
    } else if (!intro) {
      intro = line;
    } else {
      extra += (extra ? ' ' : '') + line;
    }
  }

  // heurística: se não achou steps, tenta extrair dos trechos
  if (steps.length === 0 && passages.length) {
    const auto = generateStepsFromPassages(passages, 3);
    steps.push(...auto);
  }

  // se não achou intro, usa primeiro step
  if (!intro && steps.length) {
    intro = steps[0];
  }

  return {
    answer: { intro, steps, extra },
    sources
  };
}

export async function buildAnswer(query, passages = []) {
  if (!passages || passages.length === 0) {
    return {
      answer: { intro: 'Não encontrei nada nos manuais relacionado a essa pergunta.', steps: [], extra: '' },
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
      console.warn('⚠️ buildAnswer: modelo devolveu vazio/mal formatado — usando fallback conciso.');
      parsed = localConciseFallback(query, top);
    }

    if ((!parsed.sources || parsed.sources.length === 0) && defaultSources.length) {
      parsed.sources = defaultSources;
    }

    // 🔑 Normaliza para JSON
    const ensured = normalizeAnswer(parsed, top);

    return {
      answer: ensured.answer,
      sources: ensured.sources && ensured.sources.length ? ensured.sources.slice(0, 3) : defaultSources
    };
  } catch (err) {
    console.warn('⚠️ Falha na geração via GROQ — usando fallback local:', err.message || err);
    const fallback = localConciseFallback(query, top);
    return normalizeAnswer(fallback, top);
  }
}
