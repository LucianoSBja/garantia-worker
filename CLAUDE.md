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

Cuatro archivos en `src/`, sin build step:

- **`src/index.js`** — el Worker entero (~820 líneas): rutas, pipeline RAG y la UI de chat completa devuelta como string desde `chatHTML()` (HTML + CSS + JS inline, sin frontend separado ni assets).
- **`src/ingest.js`** / **`src/ingest_file.js`** — scripts Node que parsean documentos, chunkean, embeben y hacen upsert a Vectorize vía la REST API de Cloudflare. **Duplican la misma lógica a propósito** (parsers, `chunkText`, `getEmbedding`, `upsertVectors`, filtro de VIN, constantes de modelo): un cambio en uno casi siempre debe replicarse en el otro y, si toca embeddings, también en `index.js`.
- **`src/google_auth.js`** — flujo OAuth de Google Drive, se corre una vez a mano para obtener el refresh token. Exporta `getAccessToken()`; solo dispara el flujo interactivo si se lo invoca directamente, porque `drive_upload.js` lo importa.
- **`src/drive_upload.js`** — sube los documentos a Drive y escribe el mapa nombre → URL en la clave `docs:urls` de KV. Qué está ya subido lo pregunta a Drive, no a un archivo local: Drive admite nombres repetidos en una carpeta, así que un registro de estado perdido haría subir el corpus entero de nuevo y dejaría 207 duplicados.

### Links a Drive

`handleChat` lee `docs:urls` y convierte en link markdown cada nombre de archivo que el modelo haya citado. Tres detalles:

- El reemplazo es de **una sola pasada** con una alternativa de regex por documento, ordenadas de mayor a menor longitud. De a uno, un nombre corto matchearía adentro del markdown recién insertado por otro más largo.
- Al caché KV va la respuesta **sin** los links, y la linkificación se aplica al leerla. Así republicar el mapa se refleja en lo ya cacheado.
- Si `docs:urls` no existe, la respuesta sale igual con el nombre en texto plano. La feature es opcional y no debe romper el chat.

### Renderizado de las respuestas

La salida del modelo **nunca** va directo a `innerHTML`: marked deja pasar HTML crudo, y un `<img onerror=...>` se ejecuta apenas se asigna. `renderMarkdownSeguro()` parsea el markdown en un documento inerte (`DOMParser`), lo filtra contra `ETIQUETAS_PERMITIDAS` y recién ahí inserta los nodos con `replaceChildren`.

El filtro borra **todos** los atributos salvo `href` de un `<a>` http(s), así que no hay lista negra de `on*` que mantener. Al agregar una etiqueta nueva al allowlist, pensar qué atributos habilita: la lógica falla cerrada, y romper eso es la única forma de reabrir el agujero.

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

Tres detalles fáciles de romper:

- **Task types asimétricos**: la ingesta usa `RETRIEVAL_DOCUMENT` y la consulta `RETRIEVAL_QUERY`. Son parte de la calidad del retrieval, no intercambiables.
- **Roles**: la app usa `user`/`assistant` internamente; Gemini espera `user`/`model`. La conversión pasa por `toGeminiRole()` — el historial nunca debe ir crudo a `contents`.
- **Filtro `VIN_RE`**: descarta las filas de chasis de las planillas. Es una decisión de producto documentada abajo, no una optimización — sacarlo multiplica el índice por tres y no mejora ninguna respuesta.

Las 768 dimensiones están acopladas al índice `garantia-index-gemini` (declarado en `wrangler.jsonc` y hardcodeado como `INDEX_NAME` en ambos scripts de ingesta). Cambiar el modelo o las dimensiones obliga a crear un índice nuevo y re-indexar todo — Vectorize no permite cambiar dimensiones en caliente.

### Ingesta

Chunks de 400 palabras con overlap de 50, descartando los de <50 caracteres. Los IDs son determinísticos (`nombreArchivoSanitizado-índiceDeChunk`), así que re-ingestar el mismo archivo sobreescribe en lugar de duplicar. Contrapartida conocida: si un documento se achica, los vectores de los chunks sobrantes quedan huérfanos en el índice.

`ingest.js` anota cada archivo terminado en `.ingest-checkpoint.json` (gitignoreado), así que una corrida cortada retoma donde quedó. `ingest_file.js` no lo hace: procesa un solo archivo y no tendría sentido. Ante un `429` ambos reintentan con backoff exponencial (`REINTENTOS_MAX`, 5s → 80s) y esperan `PAUSA_MS` entre fragmentos para no pasarse de los 100 requests por minuto del free tier.

La cuota gratuita de Gemini corta a los 1.000 embeddings diarios y se resetea a la medianoche del Pacífico (4 AM en Argentina). El corpus completo son ~790 fragmentos, así que entra en una tanda, pero una re-indexación total desde cero después de tocar el chunking puede no entrar.

Formatos: `.pdf` (pdf2json, solo texto — no hay OCR), `.xlsx`/`.xls` (SheetJS), `.docx` (mammoth), `.pptx` (jszip + los `<a:t>` del XML de cada diapositiva). Ojo con SheetJS: el build ESM no trae `XLSX.readFile`, hay que leer a buffer y usar `XLSX.read(buf, { type: 'buffer' })`.

**Filtro de VIN**: las planillas de anexos de campañas traen miles de filas de chasis. `VIN_RE` las descarta y en su lugar deja una línea con el total de vehículos alcanzados. Los vectores de VIN son ruido —cadenas aleatorias que embeben casi idéntico entre sí— y triplicaban el índice. La contrapartida es que el bot no puede responder "¿el chasis X entra en la campaña ABI-502?": eso es lookup exacto, no búsqueda semántica, y se resolvería con un mapa VIN→campaña en KV.

## Secrets

Tres lugares distintos, cada uno con su consumidor:

| Archivo | Lo lee | Variables |
|---|---|---|
| `.env` | scripts Node de ingesta (`source .env`) | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `GOOGLE_API_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |
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
