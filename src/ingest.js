// Script de ingesta — GarantIA
// Uso: node src/ingest.js <carpeta>

import { readdirSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { createRequire } from "module";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const INDEX_NAME = "garantia-index";

// ── Parsers ──────────────────────────────────────────────

function parsePDF(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
    parser.on("pdfParser_dataError", (err) => reject(new Error(err.parserError || "Error parsing PDF")));
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

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages.length > 0) {
    result.messages.forEach((m) => console.warn("  ⚠️  mammoth:", m.message));
  }
  return result.value;
}

// ── Chunker ──────────────────────────────────────────────

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

// ── Cloudflare API ───────────────────────────────────────

async function getEmbedding(text) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error("Error embedding: " + JSON.stringify(data.errors));
  return data.result.data[0];
}

async function upsertVectors(vectors) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vectors }),
    }
  );
  return res.json();
}

// ── Procesar archivo ─────────────────────────────────────

async function ingestFile(filePath) {
  const fileName = basename(filePath);
  const ext      = extname(filePath).toLowerCase();

  let text = "";
  try {
    if (ext === ".pdf") {
      text = await parsePDF(filePath);
    } else if (ext === ".xlsx" || ext === ".xls") {
      text = parseExcel(filePath);
    } else if (ext === ".docx") {
      text = await parseDocx(filePath);
    }
  } catch (err) {
    console.error(`  ❌ Error leyendo ${fileName}:`, err.message);
    return 0;
  }

  if (!text.trim()) {
    console.log(`  ⚠️  Sin contenido: ${fileName}`);
    return 0;
  }

  const chunks  = chunkText(text);
  const vectors = [];

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  ⚙️  Embedding ${i + 1}/${chunks.length}...\r`);
    const embedding = await getEmbedding(chunks[i]);
    vectors.push({
      id:       `${fileName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)}-${i}`,
      values:   embedding,
      metadata: { source: fileName, text: chunks[i], chunk: i },
    });
  }

  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const result = await upsertVectors(vectors.slice(i, i + batchSize));
    if (!result.success) {
      console.error(`\n  ❌ Error subiendo lote:`, result.errors);
      return 0;
    }
  }

  console.log(`  ✅ ${chunks.length} fragmentos indexados`);
  return chunks.length;
}

// ── Buscar archivos ──────────────────────────────────────

function findFiles(dir, exts = [".pdf", ".xlsx", ".xls", ".docx"]) {
  let results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat     = statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(findFiles(fullPath, exts));
    } else if (exts.includes(extname(fullPath).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || "./docs";

  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error("❌ Faltan CF_ACCOUNT_ID o CF_API_TOKEN");
    process.exit(1);
  }

  const files = findFiles(target);

  if (files.length === 0) {
    console.error(`❌ No se encontraron archivos en: ${target}`);
    console.error("   Formatos válidos: .pdf  .xlsx  .xls  .docx");
    process.exit(1);
  }

  console.log(`\n🔍 Archivos encontrados: ${files.length}`);
  files.forEach((f) => console.log(`   - ${f}`));
  console.log("");

  let totalChunks = 0;
  let errores     = 0;

  for (const file of files) {
    console.log(`\n📄 ${file}`);
    const chunks = await ingestFile(file);
    if (chunks === 0) errores++;
    totalChunks += chunks;
  }

  console.log(`\n🎉 Ingesta completa`);
  console.log(`   ✅ Fragmentos indexados: ${totalChunks}`);
  console.log(`   ❌ Archivos con error:   ${errores}\n`);
}

main();
