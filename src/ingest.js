// Script de ingesta — GarantIA
// Uso: node src/ingest.js <carpeta>

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { createRequire } from "module";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const INDEX_NAME = "garantia-index-gemini";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const GEMINI_EMBED_DIMENSIONS = 768;

// Un VIN es alfanumérico de 17 caracteres, sin I, O ni Q.
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;

// Dos fragmentos están en el mismo renglón si su Y difiere menos que esto.
// pdf2json usa una unidad propia donde ~1 es la altura de línea, así que 0.35
// tolera superíndices y viñetas sin llegar a fusionar renglones consecutivos.
const TOLERANCIA_LINEA = 0.35;

// El pie de página legal de TASA se repite en todas las páginas de todos los
// boletines. Como texto para búsqueda semántica es ruido puro: embebe parecido a
// cualquier consulta y llegaba a ocupar 100 de las 400 palabras de un fragmento.
// Los patrones van deliberadamente flojos: el mismo bloque legal aparece con
// variantes ("este boletín" / "este documento", con y sin "de Concesionarios"),
// y ser específico dejó pasar el pie de página en 8 de los 178 PDF.
const LINEA_DESCARTABLE = [
  /sólo para fines informativos/i,
  /no es el destinatario original/i,
  /contenida en este (bolet[ií]n|documento) es confidencial/i,
  /circulaci[óo]n interna de la red/i,
  /revisi[óo]n, distribuci[óo]n o copia/i,
  /^TASA\s*[–-]\s*Toyota Argentina/i,
  /^\s*(Depto\.|Departamento)\s+Servicio al Cliente\s*$/i,
  /^\s*\d+\s+de\s+\d+\s*$/,
];

// El free tier de embeddings permite 100 requests por minuto. Vamos a ~85 para
// dejar margen, y ante un 429 esperamos cada vez más antes de reintentar.
const PAUSA_MS       = 700;
const REINTENTOS_MAX = 5;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Parsers ──────────────────────────────────────────────

// Reconstruye el orden de lectura de una página desde las coordenadas de cada
// fragmento: primero agrupa por Y en renglones y después ordena cada renglón por X.
//
// Hace falta porque getRawTextContent() devuelve los bloques en el orden en que el
// PDF los guardó, que no es el de lectura: los boletines salían empezando por el
// pie de página legal, sin el encabezado (modelo, N° de boletín, tema, fecha) y con
// las secciones numeradas al revés. El texto quedaba indexado desordenado, así que
// el embedding era peor y el modelo no podía responder ni con el documento correcto.
// pdf2json entrega el texto percent-encoded, pero algunos boletines traen un "%"
// suelto que no es un escape válido y hace explotar decodeURIComponent. Sin esto
// el archivo entero se pierde: en ingest.js lo tapa el try/catch de ingestFile y
// en ingest_file.js corta la corrida.
function decodificar(texto) {
  try {
    return decodeURIComponent(texto);
  } catch {
    return texto;
  }
}

function ordenarPagina(pagina) {
  const items = (pagina.Texts || []).map((t) => ({
    x: t.x,
    y: t.y,
    s: decodificar(t.R.map((r) => r.T).join("")),
  }));

  const lineas = [];
  for (const item of items.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const ultima = lineas[lineas.length - 1];
    if (ultima && Math.abs(ultima.y - item.y) <= TOLERANCIA_LINEA) ultima.items.push(item);
    else lineas.push({ y: item.y, items: [item] });
  }

  return lineas
    .map((l) =>
      l.items
        .sort((a, b) => a.x - b.x)
        // Sin separador a propósito: pdf2json parte las palabras en varios
        // fragmentos ("Pos" "t" "venta") y los espacios reales ya vienen adentro.
        .map((i) => i.s)
        .join("")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((texto) => texto && !LINEA_DESCARTABLE.some((re) => re.test(texto)));
}

function parsePDF(filePath) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataReady", (data) => resolve((data.Pages || []).map((p) => ordenarPagina(p).join("\n")).join("\n")));
    parser.on("pdfParser_dataError", (err) => reject(new Error(err.parserError || "Error parsing PDF")));
    parser.loadPDF(filePath);
  });
}

function parseExcel(filePath) {
  // XLSX.readFile no existe en el build ESM de SheetJS (necesita un fs que no
  // trae enganchado). Leemos el archivo a buffer y lo parseamos desde ahí.
  const workbook = XLSX.read(readFileSync(filePath), { type: "buffer" });
  let text = "";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    text += `\n## Hoja: ${sheetName}\n`;

    let omitidas = 0;
    for (const row of rows) {
      const line = row.filter(Boolean).join(" | ");
      if (!line.trim()) continue;

      // Los anexos de campañas traen miles de filas de VIN. Como texto para
      // búsqueda semántica no sirven —cada VIN es una cadena aleatoria y los
      // vectores salen casi idénticos entre sí— y encima inflan el índice.
      // Nos quedamos con los encabezados, que son los que describen la campaña.
      if (VIN_RE.test(line)) {
        omitidas++;
        continue;
      }
      text += line + "\n";
    }

    // Dejamos constancia del dato agregado, que sí es consultable.
    if (omitidas > 0) {
      text += `(${omitidas} vehículos alcanzados, listado de VIN omitido del índice)\n`;
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

// Un .pptx es un ZIP con un XML por diapositiva. El texto vive en los <a:t>, así
// que alcanza con recorrer las partes en orden y juntarlos. Se incluyen las notas
// del orador: en los boletines técnicos suelen traer el desarrollo del caso.
async function parsePptx(filePath) {
  const zip = await JSZip.loadAsync(readFileSync(filePath));
  const numero = (n) => Number(n.match(/(\d+)\.xml$/)[1]);
  const partes = Object.keys(zip.files)
    .filter((n) => /^ppt\/(slides|notesSlides)\/[a-zA-Z]+\d+\.xml$/.test(n))
    .sort((a, b) => numero(a) - numero(b));

  let text = "";
  for (const parte of partes) {
    const xml = await zip.file(parte).async("string");
    const frases = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
    if (frases.length > 0) text += frases.join(" ") + "\n";
  }
  return text;
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
  for (let intento = 0; intento <= REINTENTOS_MAX; intento++) {
    const res = await fetch(
      `${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:embedContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": GOOGLE_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: GEMINI_EMBED_DIMENSIONS,
        }),
      }
    );

    if (res.status === 429) {
      if (intento === REINTENTOS_MAX) {
        throw new Error("Cuota de Gemini agotada tras " + REINTENTOS_MAX + " reintentos. Probá de nuevo más tarde.");
      }
      // 5s, 10s, 20s, 40s, 80s
      const espera = 5000 * 2 ** intento;
      process.stdout.write(`\n  ⏳ Cuota alcanzada, esperando ${espera / 1000}s...`);
      await dormir(espera);
      continue;
    }

    const data = await res.json();
    if (!data.embedding?.values) throw new Error("Error embedding: " + JSON.stringify(data));
    return data.embedding.values;
  }
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
    } else if (ext === ".pptx") {
      text = await parsePptx(filePath);
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
    if (i < chunks.length - 1) await dormir(PAUSA_MS);
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

// ── Checkpoint ───────────────────────────────────────────
// La cuota gratuita de Gemini corta a los 1.000 embeddings diarios. Anotamos
// cada archivo terminado para que una corrida cortada retome donde quedó en
// vez de volver a embeber todo desde cero.

const CHECKPOINT = ".ingest-checkpoint.json";

function leerCheckpoint() {
  if (!existsSync(CHECKPOINT)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(CHECKPOINT, "utf8")));
  } catch {
    console.warn("  ⚠️  Checkpoint ilegible, se ignora y se empieza de cero.");
    return new Set();
  }
}

function marcarHecho(filePath) {
  const hechos = leerCheckpoint();
  hechos.add(filePath);
  writeFileSync(CHECKPOINT, JSON.stringify([...hechos], null, 2));
}

// ── Buscar archivos ──────────────────────────────────────

function findFiles(dir, exts = [".pdf", ".xlsx", ".xls", ".docx", ".pptx"]) {
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

  if (!ACCOUNT_ID || !API_TOKEN || !GOOGLE_API_KEY) {
    console.error("❌ Faltan CF_ACCOUNT_ID, CF_API_TOKEN o GOOGLE_API_KEY");
    process.exit(1);
  }

  const files = findFiles(target);

  if (files.length === 0) {
    console.error(`❌ No se encontraron archivos en: ${target}`);
    console.error("   Formatos válidos: .pdf  .xlsx  .xls  .docx  .pptx");
    process.exit(1);
  }

  const hechos = leerCheckpoint();
  const pendientes = files.filter((f) => !hechos.has(f));

  console.log(`\n🔍 Archivos encontrados: ${files.length}`);
  if (hechos.size > 0) {
    console.log(`   ⏭️  Ya indexados en corridas previas: ${hechos.size}`);
    console.log(`   📋 Pendientes: ${pendientes.length}`);
  }
  console.log("");

  if (pendientes.length === 0) {
    console.log("✅ No queda nada por indexar. Borrá el checkpoint si querés rehacer todo:");
    console.log(`   rm ${CHECKPOINT}\n`);
    return;
  }

  let totalChunks = 0;
  let errores     = 0;

  for (const file of pendientes) {
    console.log(`\n📄 ${file}`);
    const chunks = await ingestFile(file);
    if (chunks === 0) errores++;
    totalChunks += chunks;
    // Se anota apenas termina, así una caída no pierde lo ya hecho.
    marcarHecho(file);
  }

  console.log(`\n🎉 Ingesta completa`);
  console.log(`   ✅ Fragmentos indexados: ${totalChunks}`);
  console.log(`   ❌ Archivos con error:   ${errores}\n`);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  console.error(`   Lo indexado hasta acá quedó registrado. Volvé a correr el script para retomar.\n`);
  process.exit(1);
});
