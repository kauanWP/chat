// src/answer.js
import { generateText } from './groq-client.js';
import { buildPrompt } from './prompt-templates.js';

/* ---------- Helpers ---------- */

function safeTrim(s = '') {
  return String(s || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

/* fallback conciso se modelo falhar */
function localConciseFallback(query, passages = []) {
  const top = passages.slice(0, 3);
  const firstSentences = top.map(p => {
    const s = safeTrim(p.text);
    const m = s.match(/(.{20,200}?[.!?])(\s|$)/);
    if (m && m[1]) return m[1].trim();
    return s.slice(0, 160).trim();
  }).filter(Boolean);

  const intro = firstSentences[0] ? `${firstSentences[0].split(/\s+/).slice(0,18).join(' ')}...` : 'Não encontrei instruções completas nos manuais.';
  const steps = firstSentences.slice(0, 3).map((s, i) => `${i+1}. ${s}`);
  const answerText = [intro, ...steps].join('\n\n');
  const sources = Array.from(new Set(top.map(p => p.source).filter(Boolean))).slice(0,3);
  return { answer: answerText, sources };
}

/* tenta extrair JSON do texto do modelo; retorna objeto com possíveis keys messages, answer, sources */
function parseModelOutput(text, passages = []) {
  if (!text) return null;
  const trimmed = String(text).trim();

  // tenta extrair JSON completo
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  let jsonPart = null;
  if (first !== -1 && last !== -1 && last >= first) {
    jsonPart = trimmed.slice(first, last + 1);
    try {
      const parsed = JSON.parse(jsonPart);
      return parsed;
    } catch (err) {
      // ignore parse error and fallback to heuristics
    }
  }

  // Se não houver JSON, cria um objeto com answer string e tenta extrair fontes
  const parts = trimmed.split(/\n{2,}/).slice(0,3).map(p => safeTrim(p));
  const answer = parts.join('\n\n').slice(0, 1200);
  const sourceMatches = [...trimmed.matchAll(/([A-Z0-9 \-_]{4,}\.pdf)/gi)].map(m => m[0]);
  const sources = Array.from(new Set(sourceMatches)).slice(0, 3);
  return { answer, sources };
}

/* extrai uma sentença curta representativa de um trecho */
function extractShortSentenceFromText(s = '') {
  const txt = safeTrim(s);
  const m = txt.match(/(.{20,220}?[.!?])(\s|$)/);
  if (m && m[1]) return m[1].trim();
  return txt.slice(0, 120).trim();
}

/* Gera até N passos a partir dos passages (heurística local) */
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

/* Normaliza qualquer parsed (string/object) para formato estruturado { answer: {intro, steps, extra}, sources } */
function normalizeToStructured(parsed, passages = []) {
  let rawAns = parsed && parsed.answer ? parsed.answer : '';
  const parsedSources = parsed && Array.isArray(parsed.sources) ? parsed.sources.slice(0,3) : [];

  // se já for objeto estruturado (intro/steps/extra)
  if (typeof rawAns === 'object' && (rawAns.intro || rawAns.steps || rawAns.extra)) {
    return {
      answer: {
        intro: safeTrim(rawAns.intro || ''),
        steps: Array.isArray(rawAns.steps) ? rawAns.steps.map(String).map(s => safeTrim(s)).filter(Boolean).slice(0,3) : [],
        extra: safeTrim(rawAns.extra || '')
      },
      sources: parsedSources
    };
  }

  // rawAns é string
  rawAns = safeTrim(String(rawAns || ''));

  const paragraphs = rawAns.split(/\n{2,}/).map(p => safeTrim(p)).filter(Boolean);

  let intro = '';
  const steps = [];
  let extra = '';

  if (paragraphs.length > 0) {
    intro = paragraphs[0];
    for (let i = 1; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      // explode itens numerados
      if (/^\d+[\.\)]\s+/.test(p) || /^[-•]\s+/.test(p) || /[0-9]+\.\s/.test(p)) {
        const items = p.split(/(?=\b[0-9]+\.\s|(?=•\s)|(?=-\s))/g)
          .map(it => it.replace(/^[0-9]+\.\s*|^[-•]\s*/, '').trim())
          .filter(Boolean);
        items.forEach(it => steps.push(safeTrim(it)));
      } else {
        const lines = p.split(/\n/).map(l => safeTrim(l)).filter(Boolean);
        if (lines.length > 1) lines.forEach(l => steps.push(l));
        else extra += (extra ? ' ' : '') + p;
      }
    }
  }

  // heurística se não temos steps
  if (steps.length === 0 && passages && passages.length) {
    const auto = generateStepsFromPassages(passages, 3);
    steps.push(...auto);
  }

  if (!intro && steps.length) {
    intro = steps[0];
    steps.shift();
  }

  const stepsTrimmed = steps.map(s => safeTrim(s)).filter(Boolean).slice(0,3);
  intro = safeTrim(intro || '');
  extra = safeTrim(extra || '');

  return {
    answer: { intro, steps: stepsTrimmed, extra },
    sources: parsedSources
  };
}

/* Gera array de mensagens curtas (1-3) a partir de parsed ou structured */
function ensureMessages(parsed, structured, passages = []) {
  // 1) se parsed já tem messages array, use e sanitize
  if (parsed && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    const m = parsed.messages.map(x => safeTrim(String(x))).filter(Boolean);
    return dedupeAndLimitMessages(m, 3);
  }

  // 2) se parsed.answer é array-like (rare), join
  if (parsed && Array.isArray(parsed.answer)) {
    const m = parsed.answer.map(x => safeTrim(String(x))).filter(Boolean);
    return dedupeAndLimitMessages(m, 3);
  }

  // 3) se structured (result of normalizeToStructured) existe, compose messages from intro+steps+extra
  if (structured && structured.answer) {
    const msgs = [];
    if (structured.answer.intro) msgs.push(safeTrim(structured.answer.intro));
    if (Array.isArray(structured.answer.steps)) msgs.push(...structured.answer.steps.map(s => safeTrim(s)).filter(Boolean));
    if (structured.answer.extra) msgs.push(safeTrim(structured.answer.extra));
    return dedupeAndLimitMessages(msgs, 3);
  }

  // 4) if parsed.answer is a string, split nicely
  if (parsed && typeof parsed.answer === 'string' && parsed.answer.trim()) {
    const maybe = splitAnswerStringToMessages(parsed.answer);
    return dedupeAndLimitMessages(maybe, 3);
  }

  // 5) fallback: from passages
  const auto = generateStepsFromPassages(passages, 3);
  return dedupeAndLimitMessages(auto, 3);
}

/* split string answer into sensible messages */
function splitAnswerStringToMessages(str) {
  const s = safeTrim(str);
  const paras = s.split(/\n{2,}/).map(p => safeTrim(p)).filter(Boolean);
  if (paras.length > 1) {
    // explode bullets/numbers within paras
    const exploded = [];
    for (const p of paras) {
      if (/^\d+[\.\)]\s+/.test(p) || /[0-9]+\.\s/.test(p)) {
        const items = p.split(/(?=\b[0-9]+\.\s)/g).map(i => i.replace(/^[0-9]+\.\s*/, '').trim()).filter(Boolean);
        exploded.push(...items);
      } else {
        const lines = p.split(/\n/).map(l => safeTrim(l)).filter(Boolean);
        if (lines.length > 1) exploded.push(...lines);
        else exploded.push(p);
      }
    }
    return exploded;
  } else {
    const lines = s.split(/\n/).map(l => safeTrim(l)).filter(Boolean);
    if (lines.length > 1) return lines;
    // otherwise split by sentences
    const sentences = s.split(/(?<=[.?!])\s+/).map(x => safeTrim(x)).filter(Boolean);
    return sentences.length > 1 ? sentences : [s];
  }
}

/* remove duplicatas (insensível a case), remove linhas de ruído e limita */
function dedupeAndLimitMessages(list = [], limit = 3) {
  const seen = new Set();
  const out = [];
  for (let item of list) {
    if (!item) continue;
    item = item.replace(/…+/g, ''); // remove reticências
    item = item.replace(/\s+/g, ' ').trim();
    if (!item) continue;
    // heurística: se item contém "MANUAL" seguido de filename, provavelmente é trecho bruto -> keep only first sentence
    if (/[A-Z0-9 \-_]{4,}\.pdf/.test(item) || /^MANUAL\s/.test(item)) {
      const first = item.split(/(?<=[.?!])\s+/)[0];
      item = safeTrim(first);
    }
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  // ensure first message short (<=18 words)
  if (out.length > 0) {
    const w = out[0].split(/\s+/);
    if (w.length > 18) out[0] = w.slice(0,18).join(' ') + '...';
  }
  return out;
}

/* ---------- Main exported function ---------- */

export async function buildAnswer(query, passages = []) {
  if (!passages || passages.length === 0) {
    return {
      // backward-compatible structured answer
      answer: { intro: 'Não encontrei nada nos manuais relacionado a essa pergunta.', steps: [], extra: '' },
      // preferred new field
      messages: ['Não encontrei nada nos manuais relacionados a essa pergunta. Sugiro abrir chamado ou fornecer mais detalhes.'],
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
    if (!parsed || (!parsed.answer && !parsed.messages)) {
      // fallback local conciso
      console.warn('⚠️ buildAnswer: modelo devolveu vazio/mal formatado — usando fallback conciso.');
      parsed = localConciseFallback(query, top); // { answer: string, sources: [] }
    }

    // ensure sources
    if ((!parsed.sources || parsed.sources.length === 0) && defaultSources.length) {
      parsed.sources = defaultSources;
    }

    // normalize structured answer
    const structured = normalizeToStructured(parsed, top);

    // ensure messages array (1-3) from parsed or structured
    const messages = ensureMessages(parsed, structured, top);

    // final safety: if no messages, create from structured
    const finalMessages = (messages && messages.length) ? messages : dedupeAndLimitMessages([structured.answer.intro, ...(structured.answer.steps || []), structured.answer.extra].filter(Boolean), 3);

    // limit length of intro for safety
    if (structured.answer.intro && structured.answer.intro.length > 1200) {
      structured.answer.intro = structured.answer.intro.slice(0, 1200) + '...';
    }

    return {
      // backward-compatible structured answer
      answer: structured.answer,
      // preferred for frontend/cli: short messages array
      messages: finalMessages,
      // sources list
      sources: (parsed.sources && parsed.sources.length) ? parsed.sources : defaultSources
    };
  } catch (err) {
    console.warn('⚠️ Falha na geração via GROQ — usando fallback local:', err.message || err);
    const fallback = localConciseFallback(query, top);
    const structured = normalizeToStructured(fallback, top);
    const messages = ensureMessages(fallback, structured, top);
    return {
      answer: structured.answer,
      messages,
      sources: fallback.sources && fallback.sources.length ? fallback.sources : defaultSources
    };
  }
}
