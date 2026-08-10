# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

GarantIA: chatbot RAG sobre garantías y boletines técnicos Toyota para el concesionario Derka y Vargas (Sáenz Peña, Chaco). Corre entero en Cloudflare Workers. El código, los comentarios y las respuestas al usuario están en español rioplatense — mantener ese idioma.

## Comandos

```bash
pnpm install && pnpm approve-builds   # approve-builds hace falta para esbuild y workerd

pnpm test                              # vitest run (unit tests, sin credenciales)
pnpm exec vitest run -t "nombre del test"   # un solo test
pnpm exec vitest                       # watch mode

wrangler dev --remote                  # ver nota de bindings abajo
wrangler deploy
```

Ingesta de documentos (scripts Node offline, no corren en el Worker):

```bash
set -a && source .env && set +a
node src/ingest.js ./docs                  # carpeta completa, recursivo
node src/ingest_file.js "docs/ARCHIVO.pdf" # un solo archivo
```

## Arquitectura

Tres archivos en `src/`, sin build step:

- **`src/index.js`** — el Worker entero (~820 líneas): rutas, pipeline RAG y la UI de chat completa devuelta como string desde `chatHTML()` (HTML + CSS + JS inline, sin frontend separado ni assets).
- **`src/ingest.js`** / **`src/ingest_file.js`** — scripts Node que parsean documentos, chunkean, embeben y hacen upsert a Vectorize vía la REST API de Cloudflare. **Duplican la misma lógica a propósito** (parsers, `chunkText`, `getEmbedding`, `upsertVectors`, constantes de modelo): un cambio en uno casi siempre debe replicarse en el otro y, si toca embeddings, también en `index.js`.

Rutas: `POST /chat`, `GET /health`, `GET /` (sirve la UI). Todo lo demás → 404.

### Flujo de `handleChat`

1. Cache KV — **solo si `history.length === 0`**. Key: `chat:${message.toLowerCase().slice(0,100)}`, TTL 1h.
2. Embedding de la consulta con `taskType: 'RETRIEVAL_QUERY'`.
3. `VECTORIZE.query(embedding, { topK: 5, returnMetadata: 'all' })`.
4. Filtro por `score > 0.55`. Sin matches, el prompt le indica explícitamente al modelo que responda "No encontré información...".
5. Generación con Gemini, historial incluido.
6. Escritura a caché, otra vez solo si era el primer mensaje.

`handleChat` se exporta (aparte del `export default`) exclusivamente para poder testearla sin levantar el runtime de Workers.

### Gemini, no Workers AI

El pipeline se migró de Workers AI (bge-m3 + Llama 3.1) a la API de Google AI Studio.

- Embeddings: `gemini-embedding-001` a **768 dimensiones** (`outputDimensionality`).
- Generación: `gemini-3.5-flash-lite`, temperature 0.2, maxOutputTokens 512.
- Auth por header `x-goog-api-key` con `env.GOOGLE_API_KEY`. No hay binding `AI` en `wrangler.jsonc`.

Dos detalles fáciles de romper:

- **Task types asimétricos**: la ingesta usa `RETRIEVAL_DOCUMENT` y la consulta `RETRIEVAL_QUERY`. Son parte de la calidad del retrieval, no intercambiables.
- **Roles**: la app usa `user`/`assistant` internamente; Gemini espera `user`/`model`. La conversión pasa por `toGeminiRole()` — el historial nunca debe ir crudo a `contents`.

Las 768 dimensiones están acopladas al índice `garantia-index-gemini` (declarado en `wrangler.jsonc` y hardcodeado como `INDEX_NAME` en ambos scripts de ingesta). Cambiar el modelo o las dimensiones obliga a crear un índice nuevo y re-indexar todo — Vectorize no permite cambiar dimensiones en caliente.

### Ingesta

Chunks de 400 palabras con overlap de 50, descartando los de <50 caracteres. Los IDs son determinísticos (`nombreArchivoSanitizado-índiceDeChunk`), así que re-ingestar el mismo archivo sobreescribe en lugar de duplicar. Contrapartida conocida: si un documento se achica, los vectores de los chunks sobrantes quedan huérfanos en el índice.

El loop de embeddings **no tiene try/catch ni checkpoint**: un fallo de la API a mitad de camino aborta la corrida entera sin reintento. Tenerlo en cuenta antes de lanzar ingestas largas.

Formatos: `.pdf` (pdf2json, solo texto — no hay OCR), `.xlsx`/`.xls` (SheetJS), `.docx` (mammoth).

## Secrets

Tres lugares distintos, cada uno con su consumidor:

| Archivo | Lo lee | Variables |
|---|---|---|
| `.env` | scripts Node de ingesta (`source .env`) | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `GOOGLE_API_KEY` |
| `.dev.vars` | `wrangler dev` | `GOOGLE_API_KEY` |
| `wrangler secret put` | Worker en producción | `GOOGLE_API_KEY` |

Los tres están gitignoreados o fuera del repo. Agregar un secret nuevo suele implicar tocar los tres.

## Tests

`vitest.config.js` es un `defineConfig` plano de Node — **no** `@cloudflare/vitest-pool-workers`. Esa dependencia se sacó a propósito: obligaba a `wrangler login` interactivo para proxear los bindings remotos, lo que hacía imposible correr tests sin credenciales.

Los tests en `test/unit/` mockean todo el borde externo: `vi.stubGlobal('fetch', ...)` ruteando por `:embedContent` / `:generateContent`, más objetos falsos para `env.VECTORIZE` y `env.garantia_cache`. Al agregar una llamada externa nueva, extender el router de fetch en el helper `mockFetch`.

## Desarrollo local

`wrangler dev` a secas **falla** con `Binding VECTORIZE needs to be run remotely` — Vectorize no se emula en Miniflare. Hace falta `wrangler dev --remote`, que a su vez requiere OAuth completo vía `wrangler login` (un `CLOUDFLARE_API_TOKEN` en el entorno no alcanza). Si no hay sesión interactiva disponible, la alternativa práctica es validar cada llamada por separado con `curl` (Gemini embed, Gemini generate, Vectorize query) y apoyarse en los unit tests.

## Estilo

`.editorconfig` + `.prettierrc`: tabs, comillas simples, punto y coma, `printWidth: 140`.

## Cloudflare

Ver `AGENTS.md`: consultar la documentación vigente de Cloudflare antes de tocar Workers/KV/R2/Vectorize en vez de confiar en conocimiento previo, y correr `wrangler types` después de cambiar bindings en `wrangler.jsonc`.
