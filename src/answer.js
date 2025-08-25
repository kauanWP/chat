// Integração RAG -> Groq + fallback
import { generateText } from './groq-client.js';
import { buildPrompt } from './prompt-templates.js';

export async function buildAnswer(query, passages = []) {
  if (!passages || passages.length === 0) {
    return {
      answer: 'Não encontrei nada nos manuais relacionado a essa pergunta.',
      sources: []
    };
  }

  // Pega os melhores 2-3 trechos
  const top = passages.slice(0, 3);
  const sources = Array.from(new Set(top.map(p => p.source)));

  // Monta prompt para Groq (controlado)
  const prompt = buildPrompt({ query, passages: top });

  // Parameters razoáveis para respostas conservadoras e consistentes
  const params = {
    max_new_tokens: 512,
    temperature: 0.15,
    top_p: 0.95
  };

  try {
    const model = process.env.GROQ_MODEL;
    // Chama wrapper Groq (faz retry, timeout, parsing)
    const generated = await generateText({ model, inputs: prompt, parameters: params });

    let answer = String(generated || '').trim();

    // Se o modelo não incluiu fontes, anexa as fontes conhecidas
    if (sources.length && !/Fonte(s)?/i.test(answer) && !/Fontes:/i.test(answer)) {
      answer += `\n\nFontes: ${sources.join(' | ')}`;
    }

    // Garantia: se resposta vazia por algum motivo, cai no fallback
    if (!answer) throw new Error('Resposta gerada vazia');

    return { answer, sources };
  } catch (err) {
    // Fallback: comportamento antigo (concat dos trechos) com aviso claro
    console.warn('⚠️  Falha na geração via GROQ — usando fallback local:', err.message || err);

    const clip = (t, n = 500) => (t.length > n ? t.slice(0, n) + '...' : t);
    const body = top.map((p, i) => `Trecho ${i + 1} (${p.source}):\n${clip(p.text)}\n`).join("\n");

    const answer =
`Pergunta: ${query}

Resumo baseado nos manuais (fallback):
${body}

Nota: a geração automática falhou; verifique o serviço Groq (GROQ_API_KEY/GROQ_MODEL) ou tente novamente.`;

    return { answer, sources };
  }
}
