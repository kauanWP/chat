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

function renderAnswer(answer, sources) {
  console.log('\n--- RESPOSTA ---');

  if (answer.intro) {
    console.log(`\n👉 ${answer.intro}`);
  }

  if (answer.steps && answer.steps.length > 0) {
    console.log('\nPassos:');
    answer.steps.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s}`);
    });
  }

  if (answer.extra) {
    console.log(`\n💡 Observação: ${answer.extra}`);
  }

  if (sources && sources.length) {
    console.log('\n📚 Fontes: ' + sources.join(' | '));
  }

  console.log('----------------\n');
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
      // pega um pool maior para o reranker escolher
      const rawHits = search(q, 8);

      // tenta rerankar (pode usar heurística se RERANK_ENABLED != '1')
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

      // DEBUG: hits encontrados
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

      const { answer, sources } = await buildAnswer(q, hits);

      renderAnswer(answer, sources);
    } catch (err) {
      console.error('Erro durante a busca/geração de resposta:', err.message || err);
      console.error('Se o problema persistir, rode "npm run ingest" e verifique store/base.json.');
    }
  }

  console.log('\nAté mais 👋');
}

main();
