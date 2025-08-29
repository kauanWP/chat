// src/cli.js
import 'dotenv/config';
import readlineSync from 'readline-sync';
import { loadIndex, search } from './search.js';
import { rerank } from './rerank.js';
import { buildAnswer } from './answer.js';

function banner() {
  console.log('==============================================');
  console.log('  ERP-IA-BOT  |  Busca local por manuais (RAG)');
  console.log('  Comandos: /reload  /quit');
  console.log('==============================================');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normaliza uma lista de mensagens: trim, remove vazios, remove '…' e dedup.
 */
function normalizeMessages(rawMsgs = [], max = 8) {
  const seen = new Set();
  const out = [];
  for (const r of rawMsgs) {
    if (!r && r !== 0) continue;
    const s = String(r).replace(/\r/g, '').trim();
    if (!s) continue;
    // remove linhas que só têm reticências ou símbolos inúteis
    if (/^[\.\-–—\s…]{1,}$/.test(s)) continue;
    // normaliza espaços e minúsculas para dedup
    const norm = s.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Converte answer (obj|string) em array de mensagens.
 * - Se answer for objeto com intro/steps/extra, usa esses campos.
 * - Se string, split por \n{1,} e usa cada linha/parágrafo como mensagem.
 */
function answerToMessages(answer) {
  if (!answer) return [];

  // se for objeto structurado { intro, steps, extra }
  if (typeof answer === 'object' && (answer.intro || Array.isArray(answer.steps) || answer.extra)) {
    const msgs = [];
    if (answer.intro) msgs.push(answer.intro);
    if (Array.isArray(answer.steps)) {
      for (const s of answer.steps) {
        if (s) msgs.push(String(s));
      }
    }
    if (answer.extra) msgs.push(answer.extra);
    return msgs;
  }

  // se for string (o que você planeja: modelo devolve \n separadores)
  if (typeof answer === 'string') {
    // primeiro tenta separar por quebras duplas (parágrafos),
    // senão por quebras simples; mantém ordem.
    const byPara = answer.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (byPara.length > 1) {
      // se dentro de um parágrafo há itens numerados "1." ou "•", explode esses em linhas
      const exploded = [];
      for (const p of byPara) {
        if (/[0-9]+\.\s|^•\s/.test(p)) {
          const items = p.split(/(?=\b[0-9]+\.\s|(?=•\s))/g).map(i => i.trim()).filter(Boolean);
          for (let it of items) {
            it = it.replace(/^[0-9]+\.\s*/, '').trim();
            if (it) exploded.push(it);
          }
        } else {
          // também quebra por linhas simples se existirem
          const lines = p.split(/\n/).map(l => l.trim()).filter(Boolean);
          if (lines.length > 1) exploded.push(...lines);
          else exploded.push(p);
        }
      }
      return exploded;
    } else {
      // sem parágrafos múltiplos: quebra por linha única ou por sentenças curtas
      const lines = answer.split(/\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 1) return lines;
      // se ainda for uma linha grande, tenta quebrar por sentenças
      const sentences = answer.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
      return sentences.length > 1 ? sentences : [answer.trim()];
    }
  }

  // fallback: stringify
  return [String(answer)];
}

/**
 * Exibe as mensagens no terminal simulando mensagens separadas (delay configurável).
 * - messages: array de strings
 * - sources: array (apenas exibidas ao final)
 */
async function playMessages(messages = [], sources = []) {
  const delay = Number(process.env.ANSWER_DELAY_MS || 700); // ms por mensagem (ajustável)
  const interDelay = Number(process.env.ANSWER_INTER_DELAY_MS || 120); // extra por tamanho

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // delay proporcional ao tamanho para parecer "digitando"
    const typingTime = Math.min(2500, Math.max(250, msg.length * 20));
    await sleep(i === 0 ? 300 : Math.max(delay, typingTime) + interDelay); // espera antes de mostrar cada
    // imprime a mensagem (formato de chat)
    // primeira mensagem sinaliza como resumo, as outras como passos
    if (i === 0) {
      console.log(`\n👉 ${msg}`);
    } else {
      console.log(`\n➡️ ${msg}`);
    }
  }

  // fontes (mostra ao final)
  if (sources && sources.length) {
    await sleep(350);
    console.log('\n📚 Fontes: ' + sources.join(' | '));
  }

  console.log('\n----------------\n');
}

async function main() {
  banner();

  try {
    const { count } = loadIndex();
    console.log(`Índice carregado com ${count} chunks.`);
  } catch (e) {
    console.error('Falha ao carregar índice. Rode "npm run ingest" primeiro.');
    console.error(e);
    process.exit(1);
  }

  while (true) {
    const q = readlineSync.question('\nPergunta > ').trim();
    if (!q) continue;

    if (q === '/quit') break;

    if (q === '/reload') {
      try {
        const { count } = loadIndex();
        console.log(`Recarregado. Chunks: ${count}`);
      } catch (e) {
        console.error('Erro ao recarregar:', e.message || e);
      }
      continue;
    }

    try {
      const rawHits = search(q, 8);

      let hits = [];
      try {
        hits = await rerank(q, rawHits, Number(process.env.RERANK_TOPK) || 3);
        if (!Array.isArray(hits) || hits.length === 0) {
          hits = rawHits.slice(0, Number(process.env.RERANK_TOPK) || 3);
        }
      } catch (rerr) {
        console.warn('⚠️  Rerank falhou, usando hits brutos:', rerr.message || rerr);
        hits = rawHits.slice(0, Number(process.env.RERANK_TOPK) || 3);
      }

      try {
        console.log('\n[DEBUG] hits:', hits.map(h => ({
          id: h.id,
          score: h.score,
          source: h.source,
          snippet: typeof h.text === 'string'
            ? h.text.slice(0, 160).replace(/\s+/g, ' ')
            : (typeof h.snippet === 'string' ? h.snippet.slice(0,160).replace(/\s+/g,' ') : '(no-text)')
        })));
      } catch (dbgErr) {
        console.warn('[DEBUG] falhou ao montar debug dos hits:', dbgErr.message || dbgErr);
      }

      if (!hits || hits.length === 0) {
        console.log('\nNenhum trecho relevante encontrado nos manuais.');
        continue;
      }

      console.log('\nGerando resposta (Grok)...');

      // buildAnswer agora pode retornar either:
      // - { answer: { intro, steps, extra }, sources: [...] }
      // - { answer: "<string com \\n separadores>", sources: [...] }
      const result = await buildAnswer(q, hits);

      // extrai answer e sources, com tolerância
      let rawAnswer = result?.answer ?? result;
      const sources = Array.isArray(result?.sources) ? result.sources : [];

      // se o buildAnswer nos retornou objeto {intro,steps,...}, transforma em mensagens
      let msgs = [];
      if (typeof rawAnswer === 'object' && (rawAnswer.intro || Array.isArray(rawAnswer.steps) || rawAnswer.extra)) {
        // utiliza o formato estruturado
        if (rawAnswer.intro) msgs.push(rawAnswer.intro);
        if (Array.isArray(rawAnswer.steps)) msgs.push(...rawAnswer.steps.filter(Boolean));
        if (rawAnswer.extra) msgs.push(rawAnswer.extra);
      } else {
        // se for string (modelo com \n), converte pra mensagens
        msgs = answerToMessages(String(rawAnswer || ''));
      }

      // limpa e deduplica mensagens
      const safeMsgs = normalizeMessages(msgs, Number(process.env.ANSWER_MAX_PARTS || 8));

      if (safeMsgs.length === 0) {
        console.log('\nNenhuma resposta gerada.');
        continue;
      }

      // exibe mensagens uma a uma
      await playMessages(safeMsgs, sources);
    } catch (err) {
      console.error('Erro durante a busca/geração de resposta:', err.message || err);
      console.error('Se o problema persistir, rode "npm run ingest" e verifique store/base.json.');
    }
  }

  console.log('\nAté mais 👋');
}

main();
