// Ingesta de archivo individual — soporta PDF, Excel y DOCX
import { basename, extname } from "path";
import { createRequire } from "module";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const INDEX_NAME = "garantia-index-gemini";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const GEMINI_EMBED_DIMENSIONS = 768;

// ── IDs ──────────────────────────────────────────────────────────────────────
function makeId(fileName, chunk) {
  const short = fileName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  return `${short}-${chunk}`;
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parsePDF(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
    parser.on("pdfParser_dataError", (err) => reject(new Error(err.parserError)));
    parser.loadPDF(filePath);
  });
}

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  let text = "";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    text += `\n## Hoja: ${sheetName}\n`;
    for (const row of rows) {
      const line = row.filter(Boolean).join(" | ");
      if (line.trim()) text += line + "\n";
    }
  }
  return text;
}

// ── NUEVO: parser para .docx ──────────────────────────────────────────────────
async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages.length > 0) {
    result.messages.forEach((m) => console.warn("  ⚠️  mammoth:", m.message));
  }
  return result.value;
}

// ── Chunking ──────────────────────────────────────────────────────────────────
function chunkText(text, chunkSize = 400, overlap = 50) {
  const words  = text.split(/\s+/);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim().length > 50) chunks.push(chunk.trim());
    i += chunkSize - overlap;
  }
  return chunks;
}

// ── Cloudflare AI embedding ───────────────────────────────────────────────────
async function getEmbedding(text) {
  const res = await fetch(
    `${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:embedContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": GOOGLE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: GEMINI_EMBED_DIMENSIONS,
      }),
    }
  );
  const data = await res.json();
  if (!data.embedding?.values) throw new Error("Error embedding: " + JSON.stringify(data));
  return data.embedding.values;
}

// ── Vectorize upsert ──────────────────────────────────────────────────────────
async function upsertVectors(vectors) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vectors }),
    }
  );
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error("Uso: node src/ingest_file.mjs <archivo>");
    console.error("     Soporta: .pdf  .xlsx  .xls  .docx");
    process.exit(1);
  }

  if (!ACCOUNT_ID || !API_TOKEN || !GOOGLE_API_KEY) {
    console.error("❌ Faltan variables de entorno: CF_ACCOUNT_ID, CF_API_TOKEN y/o GOOGLE_API_KEY");
    process.exit(1);
  }

  const fileName = basename(filePath);
  const ext      = extname(filePath).toLowerCase();

  console.log(`\n📄 Procesando: ${fileName}`);

  let text = "";

  if (ext === ".pdf") {
    text = await parsePDF(filePath);
  } else if (ext === ".xlsx" || ext === ".xls") {
    text = parseExcel(filePath);
  } else if (ext === ".docx") {
    text = await parseDocx(filePath);
  } else {
    console.error(`❌ Formato no soportado: ${ext}`);
    console.error("   Formatos válidos: .pdf  .xlsx  .xls  .docx");
    process.exit(1);
  }

  if (!text.trim()) {
    console.log("⚠️  Sin contenido extraíble en el archivo.");
    process.exit(0);
  }

  const chunks = chunkText(text);
  console.log(`🔪 Fragmentos: ${chunks.length}`);

  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  ⚙️  Embedding ${i + 1}/${chunks.length}...\r`);
    const embedding = await getEmbedding(chunks[i]);
    vectors.push({
      id:       makeId(fileName, i),
      values:   embedding,
      metadata: { source: fileName, text: chunks[i], chunk: i },
    });
  }

  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const result = await upsertVectors(vectors.slice(i, i + batchSize));
    if (!result.success) {
      console.error("\n❌ Error al indexar:", result.errors);
      process.exit(1);
    }
  }

  console.log(`\n✅ ${chunks.length} fragmentos indexados de ${fileName}\n`);
}

main();
