// src/answer.js
import { generateText } from './groq-client.js';
import { buildPrompt } from './prompt-templates.js';

/**
 * Fallback conciso se o modelo não retornar nada útil.
 */
function localConciseFallback(query, passages = []) {
  const top = passages.slice(0, 3);
  const firstSentences = top.map(p => {
    const s = p.text.replace(/\s+/g, ' ').trim();
    const m = s.match(/(.{20,200}?[\.!?])(\s|$)/);
    if (m && m[1]) return m[1].trim();
    return s.slice(0, 160).trim();
  }).filter(Boolean);

  const intro = firstSentences[0] ? `Como fazer: ${firstSentences[0].split(/\s+/).slice(0,18).join(' ')}...` : 'Não encontrei instruções completas nos manuais.';
  const steps = firstSentences.slice(0, 3).map((s, i) => `${i+1}. ${s}`);
  const answerText = [intro, ...steps].join('\n\n');
  const sources = Array.from(new Set(top.map(p => p.source).filter(Boolean))).slice(0,3);
  return { answer: answerText, sources };
}

/**
 * tenta extrair JSON do texto do modelo; se não for JSON, retorna objeto simples { answer: string, sources: [] }
 */
function parseModelOutput(text, passages = []) {
  if (!text) return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last >= first) {
    const jsonPart = text.slice(first, last + 1);
    try {
      const parsed = JSON.parse(jsonPart);
      if (parsed && (typeof parsed.answer === 'string' || typeof parsed.answer === 'object')) {
        parsed.sources = Array.isArray(parsed.sources) ? parsed.sources.slice(0,3) : [];
        return parsed;
      }
    } catch (err) {
      // segue para heurística abaixo
    }
  }

  // sem JSON: pega até 3 parágrafos curtos
  const trimmed = String(text).trim();
  const parts = trimmed.split(/\n{2,}/).slice(0, 3).map(p => p.replace(/\s+/g, ' ').trim());
  const answer = parts.join('\n\n').slice(0, 1200);
  const sourceMatches = [...trimmed.matchAll(/([A-Z0-9 \-_]{4,}\.pdf)/gi)].map(m => m[0]);
  const sources = Array.from(new Set(sourceMatches)).slice(0, 3);
  return { answer, sources };
}

/**
 * Extrai sentenças curtas representativas de trechos
 */
function extractShortSentenceFromText(s = '') {
  if (!s) return null;
  const txt = s.replace(/\s+/g, ' ').trim();
  const m = txt.match(/(.{20,220}?[\.!?])(\s|$)/);
  if (m && m[1]) return m[1].trim();
  return txt.slice(0, 120).trim();
}

/**
 * Gera até N passos a partir dos passages (heurística).
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
 * Normaliza string/obj em formato estruturado { answer: {intro, steps, extra}, sources: [] }
 */
function normalizeToStructured(parsed, passages = []) {
  // parsed.answer pode ser string ou objeto já estruturado
  let rawAns = parsed && parsed.answer ? parsed.answer : '';
  const parsedSources = parsed && Array.isArray(parsed.sources) ? parsed.sources.slice(0,3) : [];

  // Se já for objeto do tipo { intro, steps, extra }, respeita e retorna
  if (typeof rawAns === 'object' && (rawAns.intro || rawAns.steps || rawAns.extra)) {
    return {
      answer: {
        intro: String(rawAns.intro || '').trim(),
        steps: Array.isArray(rawAns.steps) ? rawAns.steps.map(String).filter(Boolean) : [],
        extra: String(rawAns.extra || '').trim()
      },
      sources: parsedSources
    };
  }

  // agora rawAns é string (ou nós faremos heurística)
  rawAns = String(rawAns || '').trim();

  // tenta extrair parágrafos separados por \n\n
  const paragraphs = rawAns.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  let intro = '';
  const steps = [];
  let extra = '';

  if (paragraphs.length > 0) {
    intro = paragraphs[0];
    for (let i = 1; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      // se encontrar itens numerados ou bullets, explode
      if (/^\d+[\.\)]\s+/.test(p) || /^[-•]\s+/.test(p) || /[0-9]+\.\s/.test(p)) {
        const items = p.split(/(?=\b[0-9]+\.\s|(?<=\n)|(?=•\s)|(?=-\s))/g).map(it => it.replace(/^[0-9]+\.\s*|^[-•]\s*/, '').trim()).filter(Boolean);
        items.forEach(it => steps.push(it));
      } else {
        // quebra por linhas se houver
        const lines = p.split(/\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length > 1) lines.forEach(l => steps.push(l));
        else extra += (extra ? ' ' : '') + p;
      }
    }
  }

  // se não encontramos steps, gera heurística a partir dos passages
  if (steps.length === 0 && passages && passages.length) {
    const auto = generateStepsFromPassages(passages, 3);
    steps.push(...auto);
  }

  // se intro vazio e steps existem, usa o primeiro step como intro resumido
  if (!intro && steps.length) {
    intro = steps[0];
    steps.shift();
  }

  // garante limites e trim
  intro = String(intro || '').trim();
  const stepsTrimmed = Array.isArray(steps) ? steps.map(s => String(s).trim()).filter(Boolean).slice(0,3) : [];
  extra = String(extra || '').trim();

  return {
    answer: {
      intro,
      steps: stepsTrimmed,
      extra
    },
    sources: parsedSources
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
      // modelo falhou -> fallback local conciso
      console.warn('⚠️ buildAnswer: modelo devolveu vazio/mal formatado — usando fallback conciso.');
      parsed = localConciseFallback(query, top);
      // parsed is { answer: string, sources: [] }
    }

    // garante fontes se modelo não trouxe
    if ((!parsed.sources || parsed.sources.length === 0) && defaultSources.length) {
      parsed.sources = defaultSources;
    }

    // normaliza para formato estruturado
    const structured = normalizeToStructured(parsed, top);

    // limite de tamanho do texto combinado (segurança)
    if (structured.answer.intro && structured.answer.intro.length > 1200) {
      structured.answer.intro = structured.answer.intro.slice(0, 1200) + '...';
    }

    return {
      answer: structured.answer,
      sources: structured.sources && structured.sources.length ? structured.sources : defaultSources
    };
  } catch (err) {
    console.warn('⚠️ Falha na geração via GROQ — usando fallback local:', err.message || err);
    const fallback = localConciseFallback(query, top);
    const structured = normalizeToStructured(fallback, top);
    return { answer: structured.answer, sources: structured.sources || defaultSources };
  }
}
