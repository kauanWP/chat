// src/ingest.js
import fs from 'fs';
import path from 'path';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

const ROOT = path.resolve(process.cwd());
const MANUAIS_DIR = path.join(ROOT, 'data', 'manuais');
const STORE_DIR = path.join(ROOT, 'store');
const STORE_FILE = path.join(STORE_DIR, 'base.json');

// Configuráveis via env (ou mantêm padrão)
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE) || 900;
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP) || 150;
const MIN_TEXT_FOR_PROCESS = Number(process.env.MIN_TEXT_FOR_PROCESS) || 80; // se extrair menos que isso, avisa (possível PDF imagem)

// util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureDirs() {
  if (!fs.existsSync(MANUAIS_DIR)) fs.mkdirSync(MANUAIS_DIR, { recursive: true });
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function normalizeWhitespace(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}

// chunking com overlap pra manter contexto - evita criar chunks vazios
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  if (!text || !text.length) return chunks;

  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    const slice = text.slice(i, end);
    const start = i;
    if (slice && slice.trim()) {
      chunks.push({ start, end, text: slice });
    }
    if (end === text.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

async function extractFromPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return normalizeWhitespace(data.text || '');
}

async function extractFromDOCX(filePath) {
  const { value } = await mammoth.extractRawText({ path: filePath });
  return normalizeWhitespace(value || '');
}

async function extractFromTXT(filePath) {
  const buf = fs.readFileSync(filePath, 'utf-8');
  return normalizeWhitespace(buf || '');
}

async function extractTextByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractFromPDF(filePath);
  if (ext === '.docx') return extractFromDOCX(filePath);
  if (ext === '.txt' || ext === '.md') return extractFromTXT(filePath);
  return '';
}

function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

async function main() {
  ensureDirs();

  const files = fs.readdirSync(MANUAIS_DIR)
    .filter(f => ['.pdf', '.docx', '.txt', '.md'].includes(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    console.log(`Coloque seus manuais em: ${MANUAIS_DIR} (.pdf/.docx/.txt/.md) e rode "npm run ingest" de novo.`);
    return;
  }

  const docs = [];
  let globalId = 1;

  for (const fname of files) {
    const full = path.join(MANUAIS_DIR, fname);
    console.log(`→ Extraindo: ${fname}`);
    let text = '';
    try {
      text = await extractTextByExt(full);
    } catch (e) {
      console.error(`   Falha ao extrair ${fname}:`, e.message || e);
      continue;
    }

    if (!text || !text.trim()) {
      console.warn(`   Vazio: ${fname} — possível PDF com imagens (precisa OCR) ou arquivo sem texto. Pulando.`);
      continue;
    }

    if (text.length < MIN_TEXT_FOR_PROCESS) {
      console.warn(`   Aviso: ${fname} tem apenas ${text.length} chars (pode ser incompleto). Incluindo, mas verifique se precisa de OCR.`);
    }

    const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    if (!chunks.length) {
      console.warn(`   Nenhum chunk válido gerado para ${fname}. Pulando.`);
      continue;
    }

    chunks.forEach((c) => {
      if (!c.text || !c.text.trim()) return; // ignorar vazio por segurança
      docs.push({
        id: globalId++,         // id único incremental
        source: fname,
        start: c.start,
        end: c.end,
        length: c.text.length,
        text: c.text
      });
    });

    // pequeno respiro pra não travar discos em PDFs grandes
    await sleep(50);
  }

  const payload = {
    createdAt: new Date().toISOString(),
    meta: {
      totalFiles: files.length,
      chunkSize: CHUNK_SIZE,
      overlap: CHUNK_OVERLAP
    },
    docs
  };

  try {
    writeAtomic(STORE_FILE, JSON.stringify(payload, null, 2));
    console.log(` Base gerada: ${STORE_FILE}`);
    console.log(` Total de chunks: ${docs.length}`);
  } catch (e) {
    console.error('Erro ao salvar base:', e);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal no ingest:', err);
  process.exit(1);
});