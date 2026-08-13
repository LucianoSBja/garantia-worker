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
2. `construirConsulta()` arma el texto a buscar con los últimos `TURNOS_DE_CONTEXTO` (3) mensajes del usuario más el actual. Se busca dos veces: con ese texto y con el que devuelve `reformularConsulta()`, ambos embebidos con `taskType: 'RETRIEVAL_QUERY'`.
3. `VECTORIZE.query(embedding, { topK: 5, returnMetadata: 'all' })` por cada consulta.
4. Filtro por `score > UMBRAL_RELEVANCIA`.
5. Generación con Gemini, historial incluido.
6. Escritura a caché, otra vez solo si era el primer mensaje.

`handleChat` se exporta (aparte del `export default`) exclusivamente para poder testearla sin levantar el runtime de Workers.

#### La búsqueda va sobre el caso acumulado, no sobre el último mensaje

El `SYSTEM_PROMPT` pide modelo, síntoma y kilometraje **de a uno** cuando el técnico trae una falla. Con eso, al tercer turno el último mensaje del usuario es algo como `130.000 km, entrega 15/01/2020`: embeberlo solo a él tira justo los datos que describen el caso. Medido, la diferencia es total — una consulta de ruido en la distribución recuperaba `Toyota 10 - T&C.pdf` a 0.70 con el último mensaje, y `ABI-515` a 0.78 con el caso acumulado.

El corte en tres turnos es para no arrastrar una consulta anterior ya cerrada. Solo entran los mensajes del usuario: las repreguntas del bot son ruido.

#### Dos tipos de consulta, y solo una repregunta

El `SYSTEM_PROMPT` separa explícitamente el caso de un vehículo con una falla —donde hace falta modelo + síntoma + kilometraje y se pregunta de a uno— de la consulta general: qué cubre o excluye un programa, qué plazos rigen, qué dice un boletín.

La separación existe porque la regla original era incondicional y hacía inservible cualquier pregunta de política. `decime todo lo que entra en Toyota 10` pedía el modelo, después el síntoma —que no existe, no hay ninguna falla— y después el kilometraje, sin llegar nunca a responder. La búsqueda, mientras tanto, ya traía 9 fragmentos correctos de `Toyota 10 - T&C.pdf` con scores de 0.74 a 0.81: lo único que faltaba era permitirle contestar.

El recordatorio por turno que arma `handleChat` repite la distinción; si se lo deja incondicional, pisa al `SYSTEM_PROMPT` y vuelve el interrogatorio.

#### Búsqueda doble: consulta cruda + consulta reescrita

Cada turno hace **dos** búsquedas y une los resultados. Antes de buscar, `reformularConsulta()` le pide a Gemini que reescriba el caso al vocabulario de los documentos, y se busca con las dos redacciones.

Existe porque el técnico escribe **síntomas** y los documentos de cobertura enumeran **componentes**. Medido: `pérdida de líquido en amortiguadores` no recuperaba la exclusión de Toyota 10 ni en el top-30, mientras que `los amortiguadores entran en garantía` la traía primera. Es la misma pregunta.

Las dos búsquedas son **complementarias, no redundantes**: la cruda encuentra los boletines técnicos (que describen síntomas) y la reescrita los términos y condiciones (que enumeran piezas). Por eso el prompt prohíbe explícitamente mencionar el síntoma en la reescritura — una versión que lo incluía devolvía `amortiguadores pérdida de fluido garantía…` y volvía a caer en los boletines, perdiendo el documento que tenía la respuesta.

Tres detalles que costaron medición:

- **Sin ejemplos concretos de pieza en el prompt.** Una versión decía `nombrá el componente como un manual: "amortiguadores de suspensión"` y el modelo lo copiaba: un caso de vibración al frenar se reescribía como amortiguadores. El ejemplo de la regla "no cambies de tema" usa frenos justamente por no ser un componente frecuente en las consultas reales.
- **Sin modelo ni kilometraje en la reescritura.** Agregando `srx 2020` a una consulta que funcionaba, los boletines de la barra deportiva de la SRX tapaban el documento general de T&C.
- **Falla abierta.** Si la reformulación falla o vuelve vacía, queda solo la búsqueda cruda, que es el comportamiento anterior. Reformular solo puede sumar.

El umbral se aplica a cada búsqueda **por separado** y recién después se unen los resultados (`unirMatches`): los scores salen de vectores de consulta distintos, así que compararlos entre sí no significa nada, pero cada uno contra su propio umbral sí. El contexto se corta en `MAX_FRAGMENTOS`.

Costo: una generación y un embedding extra por turno. Verificado sobre 20 corridas (4 casos × 5): 20/20 recuperan el documento correcto.

#### El umbral no separa limpio, y es a propósito

Medido contra el índice real con consultas acumuladas: las que tienen respuesta puntúan **0.727–0.800** y las que no, **0.694–0.740**. **Los rangos se solapan**, así que no existe un corte que discrimine — el acierto más flojo cae por debajo del peor falso positivo.

`UMBRAL_RELEVANCIA = 0.72` va apenas debajo del acierto más flojo a propósito: un falso positivo lo descarta el modelo, que igual tiene que decidir si el contexto responde; un falso negativo pierde en silencio un documento útil. **No subirlo "para filtrar mejor"** sin volver a medir: el número anterior (0.55) estaba tan abajo que la rama sin contexto no se ejecutaba nunca.

Concatenar sube todos los scores, así que el umbral está atado a `construirConsulta`. Si cambia cuántos turnos se arrastran, hay que remedir.

#### Las citas se validan contra el contexto

`validarCitas()` reescribe la línea `📄 Basado en: …` dejando **solo** los archivos que efectivamente se le pasaron al modelo en ese turno (los `matches` sobre el umbral más los sugeridos). Si no queda ninguno, la línea se reemplaza por `AVISO_SIN_RESPALDO`.

No es defensivo por las dudas: pasó en producción. Una consulta por ruido en la distribución recuperó únicamente fragmentos de ABI-515, y la respuesta —contenido genérico sobre plazos de garantía, que no está en ese boletín— cerró citando `Toyota 10 - T&C.pdf`, un archivo real del corpus que nunca estuvo en el contexto. Con la linkificación activa, esa cita inventada sale como link a Drive: el técnico abre el PDF, no encuentra lo que el bot afirmó, y el costo es la confianza en la herramienta.

La validación corre **antes** de cachear y antes de linkificar, así que a KV nunca va una cita inventada. Falla cerrado: un bug acá pierde una cita legítima, no habilita una falsa.

#### Sugerencias cuando no hay respuesta

`fuentesUnicas()` saca los `MAX_SUGERENCIAS` (3) documentos más cercanos y se los pasa al modelo **en las dos ramas**, haya o no contexto sobre el umbral. Como quien decide si hay respuesta termina siendo el modelo y no el filtro, listarlos solo en la rama "sin resultados" dejaría al técnico sin referencia justo en el caso más común: score alto sobre un documento que no viene al caso. Los nombres salen linkeados solos, porque `conLinksDeDrive` matchea por nombre de archivo.

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

**Orden de lectura de los PDF**: `pdf2json.getRawTextContent()` devuelve los bloques en el orden en que el PDF los guardó, que **no** es el de lectura. Los boletines salían empezando por el pie de página legal, sin el encabezado (modelo, N° de boletín, tema, fecha) y con las secciones numeradas al revés. `ordenarPagina()` lo reconstruye desde las coordenadas: agrupa por `y` en renglones con `TOLERANCIA_LINEA` y ordena cada uno por `x`.

Dentro de un renglón los fragmentos se unen **sin separador**, a propósito: pdf2json parte las palabras (`"Pos" "t" "venta"`) y los espacios reales ya vienen adentro de cada fragmento. Poner `' '` rompe todas las palabras partidas.

`decodificar()` envuelve `decodeURIComponent` en un try/catch porque algunos boletines traen un `%` suelto que no es un escape válido. Sin eso el archivo entero se pierde: en `ingest.js` lo tapa el `try/catch` de `ingestFile` y en `ingest_file.js` corta la corrida.

**Filtro del pie de página**: `LINEA_DESCARTABLE` descarta el bloque legal de TASA, que se repite en todas las páginas de todos los boletines. Embebe parecido a cualquier consulta y llegaba a ocupar 100 de las 400 palabras de un fragmento. El filtro es por renglón y corre después de reconstruir el orden — antes no serviría, porque el disclaimer viene entreverado con el contenido.

Medido sobre los 178 PDF del corpus: 230.591 palabras antes, 189.183 después (18% menos), 0 errores.

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
