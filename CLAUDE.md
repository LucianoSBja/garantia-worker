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

Sin build step. En `src/`:

- **`src/index.js`** — el Worker: rutas, pipeline RAG, la UI de chat (`chatHTML()`) y las rutas del panel admin.
- **`src/admin_html.js`** — la UI del panel admin (`adminHTML()`), mismo patrón que `chatHTML()`: un template string con `<style>`/`<script>` inline, sin build ni assets separados.
- **`src/admin_auth.js`** — login y sesión del panel admin.
- **`src/ingest_job_do.js`** — Durable Object `IngestJob`, el job de ingesta en background que dispara el panel admin.
- **`src/drive_worker.js`** — subida/reemplazo/borrado en Drive desde el Worker (versión fetch-based de `drive_upload.js`, para el panel).
- **`src/docs_index.js`** — índice KV de qué archivos subió el panel (`docs:index`), más el mapa `docs:urls` centralizado (antes duplicado entre el DO de ingesta y las rutas de borrado).
- **`src/chunking.js`** — chunking para el panel admin (ver "Panel admin" más abajo, por qué es una tercera copia).
- **`src/politica_modal.js`** — texto (Markdown) del modal "Política de Garantía y Mantenimiento" del chat, editable desde el panel — separado del documento indexado, ver "Panel admin".
- **`src/backfill_docs_index.js`** — script Node one-off (se corre a mano) que completa `docs:index` a partir de `docs:urls` para el corpus que nunca pasó por el panel.
- **`src/email_resend.js`** — mails transaccionales vía Resend (recuperación de contraseña del panel).
- **`src/shared/google_oauth.js`** — `getAccessToken()`, portable a Node y a Workers (sin imports de `http`/`child_process`).
- **`src/ingest.js`** / **`src/ingest_file.js`** — scripts Node que parsean documentos, chunkean, embeben y hacen upsert a Vectorize vía la REST API de Cloudflare. **Duplican la misma lógica a propósito** (parsers, `chunkText`, `getEmbedding`, `upsertVectors`, filtro de VIN, constantes de modelo): un cambio en uno casi siempre debe replicarse en el otro y, si toca embeddings, también en `index.js`.
- **`src/google_auth.js`** — flujo OAuth de Google Drive, se corre una vez a mano para obtener el refresh token. Reexporta `getAccessToken()` desde `shared/google_oauth.js`; solo dispara el flujo interactivo si se lo invoca directamente, porque `drive_upload.js` lo importa.
- **`src/drive_upload.js`** — sube los documentos a Drive (desde la terminal, corpus completo) y escribe el mapa nombre → URL en la clave `docs:urls` de KV. Qué está ya subido lo pregunta a Drive, no a un archivo local: Drive admite nombres repetidos en una carpeta, así que un registro de estado perdido haría subir el corpus entero de nuevo y dejaría 207 duplicados.

### Links a Drive

`handleChat` lee `docs:urls` y convierte en link markdown cada nombre de archivo que el modelo haya citado. Tres detalles:

- El reemplazo es de **una sola pasada** con una alternativa de regex por documento, ordenadas de mayor a menor longitud. De a uno, un nombre corto matchearía adentro del markdown recién insertado por otro más largo.
- Al caché KV va la respuesta **sin** los links, y la linkificación se aplica al leerla. Así republicar el mapa se refleja en lo ya cacheado.
- Si `docs:urls` no existe, la respuesta sale igual con el nombre en texto plano. La feature es opcional y no debe romper el chat.

### Botones de acceso rápido (pantalla de inicio)

La grilla "Consultas frecuentes" en `chatHTML()` son botones `card-btn` que llaman a `sendCard(prompt)`: cargan `prompt` en el input y lo mandan como si el técnico lo hubiera escrito, sin repreguntar la intención (a diferencia de una consulta tipo 1 con falla, que si el `prompt` no trae modelo/síntoma/kilometraje va a disparar la repregunta igual que cualquier mensaje).

El texto de `prompt` no es cosmético: **el botón no puede mandar solo el código del boletín** ("ABI-505."). Boletines de la misma familia de síntoma (ABI-505/ABI-513/ABI-496, todos "DPF lleno" en Hilux/SW4) tienen contenido casi gemelo, así que una consulta vaga no alcanza para distinguirlos — es el mismo problema que la contaminación de boletines reemplazados de más abajo, pero entre vigentes. La consulta de cada botón se armó y midió contra el índice real para confirmar que el boletín que nombra gana con margen claro sobre sus vecinos (ver ejemplo de ABI-496 más abajo, que además resultó estar reemplazado). Al agregar un botón nuevo para un boletín con parientes cercanos, medir del mismo modo antes de fijar el texto.

### Renderizado de las respuestas

La salida del modelo **nunca** va directo a `innerHTML`: marked deja pasar HTML crudo, y un `<img onerror=...>` se ejecuta apenas se asigna. `renderMarkdownSeguro()` parsea el markdown en un documento inerte (`DOMParser`), lo filtra contra `ETIQUETAS_PERMITIDAS` y recién ahí inserta los nodos con `replaceChildren`.

El filtro borra **todos** los atributos salvo `href` de un `<a>` http(s), así que no hay lista negra de `on*` que mantener. Al agregar una etiqueta nueva al allowlist, pensar qué atributos habilita: la lógica falla cerrada, y romper eso es la única forma de reabrir el agujero.

Rutas del chat: `POST /chat`, `GET /health`, `GET /` (sirve la UI). Rutas del panel admin, ver más abajo. Todo lo demás → 404.

## Panel admin

Login propio en `/admin` para subir, reemplazar y borrar documentos del índice sin pasar por la terminal — antes esto era exclusivamente `node src/ingest.js`/`ingest_file.js` a mano.

### El parseo corre en el navegador, no en el Worker

La cuenta de Cloudflare está en el **plan Free**, no Paid (la suposición inicial de que estaba en Paid, basada en que `GEMINI_LIMITER` usa un Durable Object con SQLite, era incorrecta — SQLite en Durable Objects ya está disponible en Free). El plan Free tiene **10ms de CPU por request, fijo, no configurable** (`wrangler deploy` con `limits.cpu_ms` falla directamente: *"CPU limits are not supported for the Free plan"*).

Medido en un spike contra producción: un PDF chico (108KB) parseaba server-side con `pdf2json` sin problema y daba el mismo texto que la CLI. Un PDF real del corpus de 13MB (`docs/COROLLA/Ruido Anormal Susp. Delantera - Corolla Cross.pdf`) tiraba **503 — "Exceeded CPU Limit"**, confirmado con `wrangler tail`. El corpus tiene archivos de hasta ~15MB, así que no es un caso límite raro.

Por eso el parseo (PDF/DOCX/XLSX/PPTX → texto) vive **en el navegador del admin**, adentro de `adminHTML()` (`src/admin_html.js`), con las mismas librerías que usa la CLI pero cargadas por CDN (mismo patrón que `chatHTML()` con `marked`): `pdf.js`, `mammoth.browser`, `xlsx` (SheetJS), `jszip`. El navegador no tiene el límite de CPU de Cloudflare. Solo el **texto ya extraído** viaja al Worker (en el mismo `multipart/form-data` que el archivo original, que se necesita aparte para subir a Drive) — el Worker nunca vuelve a tocar el binario para parsearlo, solo lo reenvía a Drive.

Efecto colateral: el Worker no tiene ninguna dependencia de `pdf2json`/`mammoth`/`xlsx`/`jszip` en su bundle — bajó de ~2.26MB a ~93KB al sacarlas (medido).

**Tres bugs de integración encontrados en el spike server-side** (documentados por si algún día se reconsidera parsear en el Worker, ej. pasando a plan Paid — no son relevantes para el parseo client-side actual, pero costaron medición y se pierden fácil):
- `createRequire(import.meta.url)` (como usa `pdf2json` en los scripts CLI) **falla en el pipeline de deploy de Workers** — `import.meta.url` no se resuelve ahí. Hace falta el import ESM directo.
- `mammoth` tiene un campo `"browser"` en su `package.json` que el bundler de Wrangler resuelve solo, targeteando una plataforma tipo browser. Esa variante **solo acepta `{ arrayBuffer }`**, no `{ buffer }` — pasar `{ buffer }` falla en silencio con "Could not find file in options", sin delatar la causa.
- `pdf2json` cachea su implementación de `createObjectURL` en un IIFE de nivel de módulo, evaluado una sola vez al importar. workerd tiene `URL.createObjectURL` como *stub* (existe, pero explota al llamarla) — neutralizar la propiedad tiene que pasar en un módulo importado ANTES que `pdf2json`, no en el handler de la request.

**El orden de lectura de `pdf.js` tampoco es gratis.** `getTextContent()` por sí solo alcanza para documentos simples, pero probado contra un boletín real (ABI-511) salía con el pie de página legal primero — el mismo bug que tenía `pdf2json` sin `ordenarPagina()` (ver más abajo, sección Ingesta). `parsePdfBrowser()` en `admin_html.js` reordena por coordenadas usando `item.transform` (pdf.js da `[a,b,c,d,x,y]`; el eje Y crece hacia arriba, al revés que pantalla), mismo criterio que `ordenarPagina()`. Verificado con Playwright contra el ABI-511 real: el header (modelo, N° de boletín, tema, fecha) vuelve a salir primero.

### Auth: login propio, sin servicios externos

`src/admin_auth.js`. Password nunca en texto plano en ningún lado. Sesión: token aleatorio + KV con TTL de 12h (`admin:session:<token>`), no cookie HMAC-firmada stateless — el proyecto ya usa KV para todo, y así el logout es un simple `delete`. Lockout de intentos fallidos: contador global en KV (`admin:login:fails`, 5 intentos, TTL 15 min) — no por IP, un solo admin legítimo no lo necesita, pero frena el escaneo automático de `/admin`.

**El hash vigente de la password vive en KV (`admin:password`, `{hash, salt}`), no solo en secrets.** `ADMIN_PASSWORD_HASH`/`ADMIN_PASSWORD_SALT` siguen existiendo como secrets, pero ahora son solo la semilla inicial — se usan nada más si KV todavía no tiene `admin:password`. La razón: "olvidé mi contraseña" necesita que el propio Worker pueda escribir una password nueva en tiempo de ejecución, y los secrets de `wrangler secret put` son de solo lectura desde el código — no hay binding que permita cambiarlos. `credencialesVigentes()` en `admin_auth.js` resuelve KV-primero-secret-como-fallback en cada login.

**Pantallas de login/recuperar/reset (`.app`), centradas en toda la ventana.** `.app` es `display:flex; min-height:100dvh; align-items:center; justify-content:center` — sin padding propio (se sacó a propósito: un `padding` vertical/horizontal fijo en `.app` achicaba la caja y en la práctica se veía "corrido", reportado con captura real contra un monitor grande). Arriba de la tarjeta va `.auth-brand`, una barra roja con el ícono y "GarantIA — Panel admin" — mismo lenguaje visual que el header del chat y la topbar del panel, para que el login no sea la única pantalla sin marca.

`.auth-brand` es hermano de las tres vistas (`vistaLogin`/`vistaOlvide`/`vistaReset`), no está adentro de ninguna — así que ocultarlas a ellas tres no lo oculta a él. `.app` mismo (`id="appAuth"`) es lo que hay que ocultar para que la barra desaparezca, y **eso no pasaba**: al loguearse, `mostrarDashboard()` ocultaba las tres vistas pero nunca `.app`, así que la caja `min-height:100dvh` con la sola barra roja centrada adentro seguía ocupando toda la altura de la ventana, empujando el dashboard (que es hermano de `.app`, no está adentro) fuera de la vista — reportado por el cliente como "GarantIA — Panel admin en toda la pantalla, hay que scrollear para ver el resto". Fix: `ocultarTodasLasVistas()` oculta `appAuth` también, y los tres puntos que muestran una vista de auth (`mostrarLogin`, el link "olvidé mi contraseña", el flujo de `?reset=`) lo vuelven a mostrar explícitamente. Cualquier vista nueva que se agregue adentro de `.app` tiene que seguir el mismo patrón (mostrar/ocultar `appAuth` junto con la vista), porque no hay ningún mecanismo automático que los mantenga sincronizados.

**Recuperar contraseña** (`POST /admin/forgot-password`, `POST /admin/reset-password`): el admin pide el link con su email, se compara contra `env.ADMIN_EMAIL` (var no-secreta en `wrangler.jsonc`) y, si coincide, se genera un token (`admin:reset:<token>`, KV, TTL 15 min, un solo uso) y se manda por mail vía Resend (`src/email_resend.js`) con el link `/admin?reset=<token>`. La respuesta es **la misma tanto si el email coincide como si no** — no hay que darle a nadie una forma de confirmar cuál es el email del admin. Rate limit propio (`admin:forgot:count`, 3 pedidos / 15 min) para no dejar golpear el buzón ni la cuota de Resend. El remitente usa el dominio de pruebas de Resend (`onboarding@resend.dev`) — funciona sin verificar un dominio propio; si hace falta más formalidad, verificar un dominio en el dashboard de Resend y cambiar `FROM` en `email_resend.js`.

Sesiones existentes no se invalidan al resetear la password — quedan vivas hasta que expiran solas (12h) o se hace logout. Deuda conocida, aceptable para un solo admin de bajo valor.

### Job de ingesta en background: Durable Object singleton `IngestJob`

`src/ingest_job_do.js`. Cientos de embeddings con pacing entre cada uno suman minutos — no entra en una sola request/response, y mantener la conexión HTTP abierta ese tiempo es frágil. Instancia única (`idFromName('current')`, mismo patrón que `GeminiRateLimiter`): el propio DO sabe si ya hay un job corriendo y rechaza uno nuevo (409).

`alarm()` procesa **un chunk por tick** y reprograma la siguiente alarma **desde dentro del propio try/catch**, antes de retornar. Es a propósito: si `alarm()` deja escapar una excepción, Cloudflare reintenta con backoff (2s, hasta 6 veces) y **después deja de disparar la alarma para siempre** (confirmado contra la doc vigente de Durable Objects Alarms). Un 429 de Gemini es esperable y no puede depender de esa red de seguridad — se maneja con reintento propio (`REINTENTOS_CHUNK_MAX`), y agotados los reintentos el job pasa a `error` sin reprogramar nada, a la espera de `/admin/api/upload/retry`.

**Rate limiting propio, desacoplado de `GEMINI_LIMITER` a propósito**: si el job vaciara el cupo `embed` compartido con el chat en vivo, haría esperar a un técnico — exactamente lo que `GeminiRateLimiter` existe para evitar. El job mantiene su propio pacing lento (`PACING_MS = 700`, igual que `PAUSA_MS` en la CLI), sin tocar el balde del chat. Deuda conocida: comparten la misma `GOOGLE_API_KEY`, así que el desacople es de rate-limiter de la app, no de cuota real de Google.

**Drive se sube al iniciar el job, no al terminar.** El storage de un Durable Object SQLite tiene un límite de **2MB combinados por key+value** — un archivo de 15MB no entra ahí de ninguna forma. La subida a Drive (I/O, no CPU) pasa en `iniciar()`, antes de crear el job; el job en sí solo guarda los chunks de texto (livianos) y el `driveFileId`/`driveUrl` ya resueltos.

`estado()` (la respuesta de `GET /admin/api/upload/status`) **tiene que incluir `driveFileId`/`driveUrl`**, aunque el resto del estado del job no los necesite para nada — sin ellos, el overlay optimista del panel (`pendientesOptimistas` en `admin_html.js`, para no depender de que `docs:index` en KV ya haya propagado) arma una entrada sin `driveFileId`, y el botón de preview (👁️) queda deshabilitado justo después de subir un archivo hasta que KV alcanza. Pasó en esta sesión, quedó cubierto en `ingestJob.spec.js`.

**Reemplazo**: si `docs:index[fileName]` ya existe, el upload lo trata como reemplazo — mismos IDs de Vectorize por índice de chunk (`upsert` sobreescribe solo), y el contenido en Drive se actualiza en el mismo archivo (mismo `fileId`, mismo link, vía `PATCH .../files/{id}?uploadType=resumable`) en vez de crear uno nuevo. Si el archivo nuevo tiene **menos** chunks que el viejo, `finalizar()` borra los IDs huérfanos con `deleteByIds` — el conteo exacto lo tiene `docs:index`, así que no hace falta el trial-and-error que sí necesita la CLI (ver Ingesta).

**Backfill de documentos que no pasaron por el panel.** Los ~207 documentos del corpus original, subidos por la CLI antes de que existiera el panel, no tienen entrada en `docs:index` — si el admin los "reemplaza" desde acá, `iniciar()` no puede asumir que es un upload nuevo. Antes de subir a Drive, si `docs:index[fileName]` no existe pero `docs:urls[fileName]` sí, se reconstruye lo necesario: el `driveFileId` sale del propio link de Drive (`extraerDriveFileId()`, regex sobre `/file/d/{id}/`, sin llamar a la API) y el conteo de chunks viejos se descubre probando IDs determinísticos en lotes de 50 contra `VECTORIZE.getByIds()` hasta encontrar el primer hueco (`contarChunksExistentes()`, acotado a 400 chunks). Verificado en producción contra un documento real del corpus: mismo `driveFileId` antes y después del reemplazo, sin duplicar en Drive, y `/chat` lo siguió citando bien.

**`src/backfill_docs_index.js`**: script one-off (mismo patrón que `drive_upload.js` — se corre a mano, no es parte del Worker) que aplica ese mismo backfill de una sola vez a **todo** `docs:urls`, para que el Historial del panel muestre el corpus completo y no solo lo que se tocó desde ahí. Correrlo de nuevo no duplica ni pisa nada, solo completa lo que falte. Un archivo con **0 chunks** en Vectorize (típicamente un boletín ya reemplazado y borrado del índice a mano, ver "Un boletín reemplazado..." más abajo) **no se omite**: se agrega con `estado: 'error'` y el detalle en el mensaje, para que sea visible y borrable desde el panel en vez de quedar en Drive sin ningún rastro. Corrida real sobre el corpus: 187 documentos indexados, 22 en `error` (exactamente los ABI-506/494/496 y sus anexos, los tres reemplazos ya documentados).

### `docs:index`: qué hay subido, con qué estado

`src/docs_index.js`. Vectorize no tiene forma de listar por `source` (no hay metadata index creado, ver Ingesta más abajo) — el panel mantiene su propio registro en una clave KV (`docs:index`, mismo patrón que `docs:urls`): `{ [fileName]: { estado, chunks, driveFileId, driveUrl, subidoEl, indexadoEl, error } }`.

`estado` es `'pendiente' | 'indexado' | 'error'` y se escribe en tres momentos, no solo al terminar: `'pendiente'` en `iniciar()` (nombre, chunks totales y datos de Drive ya se conocen ahí, antes de que arranque el embedding), `'indexado'` en `finalizar()`, `'error'` si el job se cae (en el catch de `alarm()` o de `finalizar()`). Así la tabla del panel puede mostrar el estado real de un documento sin depender de que el admin tenga la pestaña abierta mirando el polling del job — por ejemplo, si recarga la página a mitad de una ingesta larga.

### Rutas

| Ruta | Qué hace |
|---|---|
| `GET /admin` | Sirve `adminHTML()` (pública; el JS decide login-vs-dashboard según `GET /admin/api/files`, y un `?reset=<token>` en la URL manda directo a la pantalla de nueva contraseña) |
| `POST /admin/login` | `{password}` → cookie de sesión, 401, o 429 si hay lockout |
| `POST /admin/logout` | Borra la sesión, limpia cookie |
| `POST /admin/forgot-password` | `{email}` → manda el link de reseteo si coincide con `ADMIN_EMAIL`; misma respuesta siempre |
| `POST /admin/reset-password` | `{token, password}` → valida el token de un solo uso y guarda la password nueva en KV |
| `GET /admin/api/files` | `docs:index` + estado del job actual (protegida) |
| `POST /admin/api/upload` | `multipart/form-data` (`fileName`, `mimeType`, `text`, `file`); 409 si ya hay un job corriendo (protegida) |
| `GET /admin/api/upload/status` | Polling del job actual/último (protegida) |
| `POST /admin/api/upload/retry` | Reintenta el último job si quedó en `error` (protegida) |
| `POST /admin/api/files/:fileName/delete` | Borra de Vectorize, Drive (best-effort) y los índices KV (protegida) |
| `GET /politica` | Markdown del modal de Política — **pública**, la usa `chatHTML()` |
| `POST /admin/api/politica` | Guarda el Markdown del modal (protegida) |

Todas las protegidas pasan por `requireAdminSession()`, un único helper — nada de auth ad-hoc por handler. Las rutas de upload/status/retry son delgadas: reenvían la request directo al Durable Object (`env.INGEST_JOB.get(idFromName('current')).fetch(...)`), que hace todo el trabajo real.

### UI del panel: tabla, modales, toasts

Todo vive en `adminHTML()` (`src/admin_html.js`), mismo patrón sin build-step. Paleta deliberada: el rojo Toyota queda reservado para la marca (header) y para lo destructivo (borrar) — es el mismo rojo a propósito, "esto es serio" en los dos casos. Las acciones primarias (subir, confirmar, guardar contraseña) usan un azul aparte para no competir con esa señal; gris para lo secundario.

- **Tabla de documentos**: columnas Archivo / Subido / Indexado / Estado / Fragmentos / Acciones (👁️ preview, ✏️ editar, 🗑️ eliminar). Fechas y conteo de fragmentos en fuente monoespaciada — registro de "ficha de service", no texto corrido. Ordenada por fecha de subida, más nuevo primero.
- **Tabs Recientes/Historial**: "Recientes" filtra client-side por `subidoEl` dentro de los últimos 7 días; "Historial" muestra todo. Sin ida y vuelta al servidor — el mismo `GET /admin/api/files` ya trae todo, el filtro es puro JS.
- **Paginador**: `renderizarLista()` corta la lista ya ordenada/filtrada a `TAMANO_PAGINA` (8 — con 10 el cliente reportó que rompía la UI) por página, con Anterior/Siguiente — "Historial" con el corpus completo (~200 documentos) era scroll infinito sin esto. `paginaActual` se resetea a 1 al cambiar de tab o de búsqueda; si la lista se achica (por ejemplo tras borrar) y la página activa queda fuera de rango, se recorta sola al último total de páginas.
- **Buscador**: filtra por nombre de archivo en tiempo real, sobre la tab activa.
- **Badge de estado**: pill con punto de color — verde `Indexado`, ámbar `Pendiente` (con el punto pulsando), rojo `Error`. Fila entera con un shimmer sutil mientras está `pendiente`, respetando `prefers-reduced-motion`.
- **Modal de confirmación genérico** (`confirmar({titulo, mensaje, textoConfirmar})`, devuelve una Promise<boolean>) reemplaza el `confirm()` nativo del browser para borrar: texto explícito con el nombre del archivo y la advertencia de que no se puede deshacer, botón de confirmar en rojo destructivo.
- **Modal de edición/reemplazo**: "Editar 'nombre.pdf'" + selector de archivo. El botón "Guardar cambios" **arranca inactivo** (`disabled`) y solo se habilita con el evento `change` del `<input type="file">` — no alcanza con abrir el modal, tiene que haber un archivo elegido de verdad. Mismo criterio en la tarjeta de Política: "Guardar cambios" arranca inactivo al cargar, se habilita con el primer `input` que haga que el textarea difiera del valor cargado, y **vuelve a inactivarse** si el texto termina igual al original (deshacer un cambio a mano) — comparación de contenido real, no "se tocó el campo".
- **Preview de documento** (👁️): abre un modal grande con un `<iframe src="https://drive.google.com/file/d/{driveFileId}/preview">` — el visor nativo de Drive entiende PDF/DOCX/XLSX/PPTX sin que el panel tenga que renderizar nada. El botón queda deshabilitado si el documento no tiene `driveFileId` (el caso ya documentado de un Google Doc nativo en vez de un archivo subido). El `src` del iframe se vacía al cerrar el modal, para cortar cualquier carga en curso.
- **Toasts**: cola simple en `#toastContainer`, sin librería — "Archivo subido con éxito", "Indexación completada", "Documento eliminado correctamente", errores en rojo. Autodescartan a los ~3.8s.

### Layout responsivo: sidebar / hamburguesa, tabla → tarjetas

`#vistaDashboard` vive **fuera** de `.app` (el wrapper de 960px de las pantallas de login) a propósito: con sidebar necesita todo el ancho de la ventana, no la caja centrada y angosta del login.

- **Desktop** (>1140px): sidebar fija a la izquierda con dos destinos — "Documentos" (subida + tabla) y "Política de Garantía" — más el botón de cerrar sesión abajo. El clic en un `.nav-item` alterna qué `<section>` está `hidden` y actualiza el título de la topbar; no hay ruteo real, es un toggle de visibilidad.
- **Mobile/tablet** (≤1140px): la sidebar pasa a `position: fixed` con `transform: translateX(-100%)`, hasta 260px de ancho, y un botón ☰ en la topbar la trae a la vista (`transform: translateX(0)`, transición de .2s) con un overlay atrás que la cierra al tocarlo — cuidado si se testea con Playwright en un viewport angosto: el overlay cubre toda la pantalla, pero la propia sidebar (z-index más alto) tapa la porción izquierda, así que un click "al medio" del overlay en un viewport de ~390px cae arriba de la sidebar, no del backdrop — hay que clickear explícitamente a la derecha del ancho de la sidebar.
- **Tabla → tarjetas** (≤680px): sigue siendo una `<table>` real en el DOM (accesible, sin reconstruir nada en JS aparte de togglear CSS) — cada `<td>` lleva un `data-label` puesto en `renderizarLista()`, y a partir de ese breakpoint `thead` se oculta, cada `<tr>` pasa a ser un bloque con borde, y cada `<td>` muestra su `data-label` vía `::before` en vez de depender de la columna. Encima de 680px es la tabla de siempre, con scroll horizontal (`.tabla-wrap { overflow-x: auto }`) como red de seguridad si algún día hay más columnas de las que entran — sigue existiendo entre 680-860px aprox., contenido siempre adentro de `.tabla-wrap` (nunca desborda la página, verificado con `document.body.scrollWidth`).
- **Objetivo táctil de 44×44px**: el mismo breakpoint de 680px sube `min-height`/`min-width` de `.btn`, `.tab`, `.nav-item` y los botones de ícono de la tabla — en desktop se quedan compactos, en mobile se agrandan para el dedo.
- **Ancho del contenido: `width: 100%`, sin tope.** Primero se probó `max-width: 1440px` (venía de 960px, heredado sin querer del wrapper de las pantallas de login) pero en un monitor grande seguía dejando franjas vacías a los costados — reportado con captura real. `.app-shell` no tiene ningún máximo: llena la ventana entera, y el único margen respecto al borde es el padding de `.main` (más chico en mobile, más grande a partir de 1100px). Para una tabla de datos, en vez de una página de lectura, más ancho siempre es mejor — no hay motivo para poner un techo artificial.
- **Botones con texto en desktop, solo ícono en mobile — con container query, no viewport**: los botones de acción (👁️ / ✏️ / 🗑️) llevan un `<span class="texto-accion">`, mostrado solo cuando `.card` (que tiene `container-type: inline-size`) mide **1000px o más** de ancho real (`@container`, no `@media`). Es a propósito: el ancho disponible para la tarjeta depende de si la sidebar está fija (se come 224px) o en modo drawer, no solo del viewport — un `@media` fijo por viewport quedaba bien en un ancho y desbordaba en otro según el estado de la sidebar. Medido en producción: con sidebar fija y texto en los botones, un viewport de 1024px hacía overflow de hasta 287px en `.tabla-wrap` (la columna Acciones quedaba cortada) — pasó justo en la sesión donde se agregó el texto a los botones sin re-medir el breakpoint de la sidebar. El fix real fueron dos cosas juntas: la container query (el texto ya no se activa a un ancho de tarjeta insuficiente) y subir el breakpoint sidebar-fija/drawer de 860px a **1140px**, para que la sidebar deje de comerse 224px justo en la franja de anchos donde menos sobraba. Si se toca cualquiera de los dos números, remedir con un barrido real de anchos (`tabla-wrap.scrollWidth - clientWidth` en cada uno), no a ojo — así se encontró y así se confirmó el arreglo.

### Dos contenidos distintos para "Política de Garantía": el documento indexado y el resumen del modal

El modal de "Política de Garantía y Mantenimiento" que ve el técnico en el chat (botón 📘 del header) **no** se genera desde el PDF indexado — es un resumen curado, con su propio formato. Son dos piezas de contenido separadas, con dos mecanismos de edición distintos:

1. **Lo que usa `/chat` para responder preguntas**: el documento indexado (`Politica_Garantia_y_Mantenimiento_Toyota.pdf`), se actualiza subiendo un archivo nuevo desde el panel con el mismo nombre (reemplazo, ver más arriba).
2. **El resumen del modal**: vive en KV (`politica:modal_markdown`, `src/politica_modal.js`) como Markdown, editable desde una tercera tarjeta del panel admin (`GET /politica` público para leer, `POST /admin/api/politica` protegida para guardar). `chatHTML()` ya no tiene el contenido fijo en el HTML — el modal arranca vacío (`<div id="modalPoliticaBody">`) y al abrirse pide `GET /politica` y lo renderiza con **el mismo sanitizador que ya usan las respuestas del chat** (`renderMarkdownSeguro()` + `ETIQUETAS_PERMITIDAS`): aunque el admin es de confianza, es contenido que ya no se escribe a mano en este archivo, así que pasa por el mismo camino seguro que cualquier texto ajeno. Semilla inicial en `TEXTO_POR_DEFECTO` dentro de `politica_modal.js` — el mismo texto que antes vivía como HTML fijo, transcripto a Markdown, para no perder nada al migrar.

Las clases CSS del modal (`.modal-table`, `.modal-note`, `.modal-footnote`) se cambiaron por selectores sobre etiquetas dentro de `.modal-body` (`table`, `blockquote`, `hr + p`): `limpiarNodo()` borra **todos** los atributos al sanitizar, así que una clase puesta a mano en el Markdown nunca iba a sobrevivir.

**La tarjeta de Política en el panel tiene dos modos, no un textarea siempre visible**: por defecto muestra `#politicaPreview` (el Markdown ya renderizado y sanitizado — mismo criterio que el modal del chat, con `marked` + `limpiarNodoPolitica()` duplicado en `admin_html.js`, porque son dos `<script>` de páginas distintas sin forma de compartir código sin build step) y un botón "✏️ Editar Política". Recién al tocarlo aparece `#politicaEdicion` (el textarea + Cancelar/Guardar). "Cancelar" vuelve a la vista previa sin tocar `politicaOriginal`; guardar con éxito también vuelve solo a vista previa, pero re-renderizando desde el contenido recién guardado — así el admin nunca queda mirando un textarea suelto, ve el resultado real antes y después de editar.

### Flujo de `handleChat`

1. Cache KV — **solo si `history.length === 0`**. Key: `chat:v${VERSION_CACHE}:${message.toLowerCase().slice(0,100)}`, TTL 1h.
2. `construirConsulta()` arma el texto a buscar con los últimos `TURNOS_DE_CONTEXTO` (3) mensajes del usuario más el actual. Se busca dos veces: con ese texto y con el que devuelve `reformularConsulta()`, ambos embebidos con `taskType: 'RETRIEVAL_QUERY'`.
3. `VECTORIZE.query(embedding, { topK: 5, returnMetadata: 'all' })` por cada consulta.
4. Filtro por `score > UMBRAL_RELEVANCIA`.
5. Generación con Gemini, historial incluido.
6. Escritura a caché, otra vez solo si era el primer mensaje.

`handleChat` se exporta (aparte del `export default`) exclusivamente para poder testearla sin levantar el runtime de Workers.

#### La búsqueda va sobre el caso acumulado, no sobre el último mensaje

El `SYSTEM_PROMPT` pide modelo, síntoma y kilometraje **de a uno** cuando el técnico trae una falla. Con eso, al tercer turno el último mensaje del usuario es algo como `130.000 km, entrega 15/01/2020`: embeberlo solo a él tira justo los datos que describen el caso. Medido, la diferencia es total — una consulta de ruido en la distribución recuperaba `Toyota 10 - T&C.pdf` a 0.70 con el último mensaje, y `ABI-515` a 0.78 con el caso acumulado.

El corte en tres turnos es para no arrastrar una consulta anterior ya cerrada. Solo entran los mensajes del usuario: las repreguntas del bot son ruido.

#### El caché lleva versión, y hay que subirla

`VERSION_CACHE` va adentro de la clave. **Subirla al tocar el `SYSTEM_PROMPT`, el prompt de reformulación o el pipeline de búsqueda.**

Sin eso, un deploy que cambia el comportamiento no invalida nada: las respuestas generadas con la lógica anterior se siguen sirviendo hasta que vence el TTL de una hora, y parece que el deploy no funcionó. Pasó exactamente así con `decime todo lo que entra en toyota 10` — ya arreglada la repregunta, seguía devolviendo el pedido de modelo desde el caché, con `cached: true`. Las claves viejas no se borran, vencen solas.

#### Dos tipos de consulta, y solo una repregunta

El `SYSTEM_PROMPT` separa explícitamente el caso de un vehículo con una falla —donde hace falta modelo + síntoma + kilometraje y se pregunta de a uno— de la consulta general: qué cubre o excluye un programa, qué plazos rigen, qué dice un boletín.

La separación existe porque la regla original era incondicional y hacía inservible cualquier pregunta de política. `decime todo lo que entra en Toyota 10` pedía el modelo, después el síntoma —que no existe, no hay ninguna falla— y después el kilometraje, sin llegar nunca a responder. La búsqueda, mientras tanto, ya traía 9 fragmentos correctos de `Toyota 10 - T&C.pdf` con scores de 0.74 a 0.81: lo único que faltaba era permitirle contestar.

El recordatorio por turno que arma `handleChat` repite la distinción; si se lo deja incondicional, pisa al `SYSTEM_PROMPT` y vuelve el interrogatorio.

Nombrar un modelo junto a una pieza puntual no alcanza para que el modelo lo tome como tipo 1: medido contra `¿La cerradura del portón trasero de la Hilux entra en Toyota 10?` (un caso de prueba real del cliente), la regla sin esta aclaración pedía kilometraje 3 de 4 veces pese a la salvedad de "ante la duda". El dato ya estaba en `Toyota10_Garantia_por_Modelo.docx`; lo único que fallaba era la clasificación. Se agregó una aclaración explícita con un ejemplo ajeno al caso real (traba del capot / Corolla, no cerradura / Hilux) para no repetir el error de la reescritura de sobreajustarse a un ejemplo literal — verificado 5/5 sobre la frase reportada, sin regresión en los dos casos generales anteriores.

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

**Mejorado, no perfecto: dilución de chunk en `Toyota10_Garantia_por_Modelo.docx`.** El documento repite casi el mismo párrafo de "Confort y equipamiento" para cada uno de los 7 modelos, con `cerraduras` como una pieza más en una lista larga (limpiaparabrisas, techo solar, asientos, ópticas...). Con el chunking genérico de 400 palabras, una consulta puntual sobre esa pieza (`¿la cerradura del portón trasero de la Hilux entra en Toyota 10?`) quedaba pegada al umbral tanto en la búsqueda cruda (0.67) como en buena parte de las reformulaciones (0.71–0.74) — medido en producción, 2 de 5 corridas frescas caían en "no encontré datos" pese a que el dato está en el corpus. No era un problema de umbral: subirlo o bajarlo no lo arreglaba, porque el score estaba diluido por el chunk, no por el corte.

Fix: `chunkGarantiaPorModelo()` en `ingest.js`/`ingest_file.js` reemplaza el chunking genérico **solo para este archivo** — un chunk por sección de cobertura y modelo (`Motor`, `Carrocería`, etc.), con el modelo como prefijo (`[HILUX] Carrocería: ...`), en vez de bloques de 400 palabras que mezclaban varias secciones. Así "cerraduras" no compite por espacio con el resto de Carrocería, y el prefijo distingue un modelo de otro aunque el contenido sea casi idéntico. De 16 chunks pasó a 137. Si la estructura del documento cambia (deja de tener exactamente los 7 modelos esperados), la función devuelve `null` y cae sola al chunking genérico — no rompe la ingesta.

Remedido tras el fix, con la reformulación real de producción (5 corridas frescas sobre la frase reportada): **4 de 5 superan el umbral** (0.729, 0.718, 0.729, 0.737, 0.728), contra ~3 de 5 antes. Mejora real y medida, no una solución perfecta — la reformulación sigue siendo no determinística (temperature 0.2) y una corrida puntual puede quedar justo debajo del corte, que es exactamente el comportamiento esperado de un umbral que a propósito no separa limpio (ver arriba). No hay que tocar `UMBRAL_RELEVANCIA` por esto.

#### Las citas se validan contra el contexto

`validarCitas()` reescribe la línea `📄 Basado en: …` dejando **solo** los archivos que efectivamente se le pasaron al modelo en ese turno (los `matches` sobre el umbral más los sugeridos). Si no queda ninguno, la línea se reemplaza por `AVISO_SIN_RESPALDO`.

No es defensivo por las dudas: pasó en producción. Una consulta por ruido en la distribución recuperó únicamente fragmentos de ABI-515, y la respuesta —contenido genérico sobre plazos de garantía, que no está en ese boletín— cerró citando `Toyota 10 - T&C.pdf`, un archivo real del corpus que nunca estuvo en el contexto. Con la linkificación activa, esa cita inventada sale como link a Drive: el técnico abre el PDF, no encuentra lo que el bot afirmó, y el costo es la confianza en la herramienta.

La validación corre **antes** de cachear y antes de linkificar, así que a KV nunca va una cita inventada. Falla cerrado: un bug acá pierde una cita legítima, no habilita una falsa.

#### Sugerencias cuando no hay respuesta

`fuentesUnicas()` saca los `MAX_SUGERENCIAS` (3) documentos más cercanos y se los pasa al modelo **en las dos ramas**, haya o no contexto sobre el umbral. Como quien decide si hay respuesta termina siendo el modelo y no el filtro, listarlos solo en la rama "sin resultados" dejaría al técnico sin referencia justo en el caso más común: score alto sobre un documento que no viene al caso. Los nombres salen linkeados solos, porque `conLinksDeDrive` matchea por nombre de archivo.

### Gemini, no Workers AI

El pipeline se migró de Workers AI (bge-m3 + Llama 3.1) a la API de Google AI Studio.

- Embeddings: `gemini-embedding-001` a **768 dimensiones** (`outputDimensionality`).
- Generación: `gemini-3.5-flash-lite`, temperature 0.2, `maxOutputTokens` en `MAX_TOKENS_RESPUESTA` (1536). Con 512 las respuestas largas se cortaban y perdían la cita, que va al final: la enumeración completa de coberturas de Toyota 10 usa hasta 1131 tokens.
- Auth por header `x-goog-api-key` con `env.GOOGLE_API_KEY`. No hay binding `AI` en `wrangler.jsonc`.

Tres detalles fáciles de romper:

- **Task types asimétricos**: la ingesta usa `RETRIEVAL_DOCUMENT` y la consulta `RETRIEVAL_QUERY`. Son parte de la calidad del retrieval, no intercambiables.
- **Roles**: la app usa `user`/`assistant` internamente; Gemini espera `user`/`model`. La conversión pasa por `toGeminiRole()` — el historial nunca debe ir crudo a `contents`.
- **Filtro `VIN_RE`**: descarta las filas de chasis de las planillas. Es una decisión de producto documentada abajo, no una optimización — sacarlo multiplica el índice por tres y no mejora ninguna respuesta.

Las 768 dimensiones están acopladas al índice `garantia-index-gemini` (declarado en `wrangler.jsonc` y hardcodeado como `INDEX_NAME` en ambos scripts de ingesta). Cambiar el modelo o las dimensiones obliga a crear un índice nuevo y re-indexar todo — Vectorize no permite cambiar dimensiones en caliente.

#### La cuota de Gemini corta por minuto, no solo por día, y sin reintento eso rompía el chat

Cada turno de `handleChat` hace hasta 4 llamadas a Gemini (reformular, dos embeddings en paralelo, respuesta final). La cuota gratuita tiene un tope por minuto además del diario de 1.000 embeddings — bastante bajo — y `embedText`/`generateReply` no tenían reintento: un único 429 (`RESOURCE_EXHAUSTED`) tiraba el turno entero al catch general de `handleChat` y devolvía `Error interno. Intentá de nuevo.`

No era hipotético. Reportado por el cliente como "no responde ante consulta sobre vibración al frenar" y reproducido contra producción: una ráfaga de 8-10 consultas en paralelo (dos técnicos usando el chat a la vez alcanza) tiraba 429 en 6 a 8 de cada 10, confirmado con `wrangler tail` viendo el error real de Gemini.

Fix: `fetchConReintento()` envuelve las dos llamadas con reintento corto (3 intentos, backoff con jitter) — corto a propósito porque hay un usuario esperando la respuesta, no es la ingesta en lote. Reduce el problema a nivel de ráfagas moderadas, verificado tras el deploy, pero **no lo resuelve del todo**: bajo carga sostenida por encima de la cuota por minuto (medido con 10 requests simultáneos autogenerados, un escenario más agresivo que el uso real del taller), una porción sigue agotando los 3 reintentos y cae en la respuesta de fallback ("No pude generar una respuesta"), que al menos no es un error 500. La solución de fondo es pedir un aumento de cuota en la consola de Google Cloud/AI Studio — eso lo tiene que hacer el cliente, no es un cambio de código.

**Mitigación adicional: `GeminiRateLimiter`, un Durable Object que frena el Worker antes de generar el 429, en vez de solo reaccionar después.** `esperarCupoGemini()` le pide cupo antes de cada llamada (`embedText` y `generateReply`); si no hay, la espera la genera el propio Durable Object antes de dejar pasar. Balde de tokens en memoria, sin `state.storage`: si la instancia se descarta por inactividad el balde reaparece lleno, que es lo correcto. Baldes separados para `embed` y `generate` porque Google cuota cada modelo aparte.

Los números (`CUPO_GEMINI`: ráfaga de 10, sostenido 30/min por tipo) son deliberadamente holgados, no una réplica de la cuota real de Google, que no está publicada y varía por proyecto. Calibrado contra este proyecto con la cuota ya recuperada de pruebas previas: **25 pedidos secuenciales y hasta 30 simultáneos entraron sin ningún 429** — el límite real parece ser de volumen acumulado en una ventana, no de concurrencia pura, y se dispara con uso pesado sostenido (varias tandas de prueba seguidas en pocos minutos), no con el uso real de un puñado de técnicos. Por eso el limitador es contención ante una ráfaga patológica, no un freno de mano al uso normal — y `fetchConReintento` sigue siendo el respaldo si la cuota real resulta más ajustada de lo medido. Si en producción se ve que sigue habiendo 429, bajar `porMinuto` recién ahí, con datos reales de uso, no adivinando.

La clase se testea directa en `test/unit/geminiRateLimiter.spec.js` con `vi.useFakeTimers()`, sin pasar por el runtime de Workers — no usa `state.storage` ni ninguna API específica de Durable Objects, así que es una clase JS común. Requiere `durable_objects` + `migrations` (`new_sqlite_classes`) en `wrangler.jsonc` y correr `wrangler types` después.

### Ingesta

Chunks de 400 palabras con overlap de 50, descartando los de <50 caracteres. Excepción: `Toyota10_Garantia_por_Modelo.docx` usa `chunkGarantiaPorModelo()`, un chunker estructural propio — ver el detalle en "El umbral no separa limpio" más abajo. Los IDs son determinísticos (`nombreArchivoSanitizado-índiceDeChunk`), así que re-ingestar el mismo archivo sobreescribe en lugar de duplicar. Contrapartida conocida: si un documento se achica, los vectores de los chunks sobrantes quedan huérfanos en el índice.

**Un boletín reemplazado por uno nuevo no sale solo del índice — hay que borrarlo a mano.** Cuando un ABI nuevo sustituye a uno viejo (el propio texto del boletín nuevo suele decirlo: "el presente boletín sustituye..."), el viejo se queda en Vectorize indexado igual que cualquier otro documento y compite en el retrieval — a veces con score más alto, porque nada en el pipeline sabe que está obsoleto. Pasó tres veces: ABI-506 (discontinuado), ABI-494 (reemplazado por ABI-511, que además revirtió una recomendación — pasó de permitir el reemplazo de discos de freno a restringirlo — así que el boletín viejo no solo competía en el ranking, lo hacía con información contradictoria) y ABI-496 (reemplazado por ABI-505, encontrado recién al armar los botones de acceso rápido: una consulta bien formada sobre "¿qué dice el ABI-505 sobre el DPF?" traía a ABI-496 en el top-3 con score 0.832, casi empatado con el vigente en 0.860). Vale la pena, ante cualquier boletín que se vaya a citar textualmente (por ejemplo desde un botón de acceso rápido), revisar primero si el propio texto dice "el presente boletín sustituye..." y, si sustituye a otro, chequear que el viejo ya no esté en el índice. El fix es siempre el mismo: reconstruir los IDs determinísticos del archivo viejo (`get_by_ids` probando `sanitize(nombreConExtensión)-0`, `-1`, ... — el límite de la API es 20 ids por request) y `delete_by_ids`. No hay lookup por metadata: el índice no tiene un metadata index creado para `source`, así que `filter` en `query` devuelve 0 resultados aunque el documento exista.

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
| `.dev.vars` | `wrangler dev` | `GOOGLE_API_KEY`, `ADMIN_PASSWORD_HASH`, `ADMIN_PASSWORD_SALT`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `RESEND_API_KEY` |
| `wrangler secret put` | Worker en producción | Las mismas siete que `.dev.vars` |
| `wrangler.jsonc` → `vars` | Worker en producción (no-secreto) | `ADMIN_EMAIL` |

Los tres `GOOGLE_OAUTH_*`/`GOOGLE_REFRESH_TOKEN` viven duplicados entre `.env` (CLI) y `.dev.vars`/producción (panel admin, para subir a Drive desde el Worker) — mismo valor, dos consumidores con acceso a `process.env` vs. `env.*` distintos.

`ADMIN_PASSWORD_HASH`/`ADMIN_PASSWORD_SALT` se generan una sola vez a mano: `SHA-256(password + salt)` en hex, con Web Crypto (`crypto.subtle.digest`). Son solo la **semilla inicial** — una vez que el admin resetea la password una vez desde "¿Olvidaste tu contraseña?", el hash vigente pasa a vivir en KV (`admin:password`) y estos dos secrets dejan de leerse (ver "Panel admin" más arriba). No hace falta re-cargarlos para cambiar la password del día a día — el flujo de reseteo ya hace eso.

`RESEND_API_KEY` es de [resend.com](https://resend.com) (free tier), usada solo para el mail de "olvidé mi contraseña". `ADMIN_EMAIL` no es secreta —es el email contra el que se valida el pedido de reseteo— así que va como `vars` en `wrangler.jsonc`, no como secret.

Los archivos con secrets están gitignoreados o fuera del repo. Agregar un secret nuevo suele implicar tocar `.dev.vars` y `wrangler secret put`.

## Tests

`vitest.config.js` es un `defineConfig` plano de Node — **no** `@cloudflare/vitest-pool-workers`. Esa dependencia se sacó a propósito: obligaba a `wrangler login` interactivo para proxear los bindings remotos, lo que hacía imposible correr tests sin credenciales.

Los tests en `test/unit/` mockean todo el borde externo: `vi.stubGlobal('fetch', ...)` ruteando por `:embedContent` / `:generateContent`, más objetos falsos para `env.VECTORIZE` y `env.garantia_cache`. Al agregar una llamada externa nueva, extender el router de fetch en el helper `mockFetch`.

Del panel admin: `adminAuth.spec.js` (hash/compare/cookie/lockout, y el flujo completo de olvidé-mi-contraseña: rate limit, token de un solo uso, no-oráculo cuando el email no coincide), `ingestJob.spec.js` (la clase `IngestJob` con `state.storage` falso — `Map` en memoria —, un Vectorize falso con estado real para poder probar el backfill, y el mismo router de `fetch` para Gemini/Drive/OAuth), `chunking.spec.js` (la copia de chunking del Worker, primera vez que esta lógica tiene tests automatizados en el proyecto), `docsIndex.spec.js` (merge de `docs:index`, mapa `docs:urls`, `extraerDriveFileId`), `politicaModal.spec.js` (default vs. guardado en KV). **Los parsers y la UI client-side de `admin_html.js`/`chatHTML()` no tienen test automatizado** — no hay infraestructura de tests de browser en el proyecto; se verifican con Playwright ad-hoc contra la producción real (login, tabla, tabs, buscador, modales, toasts, subida con parseo real, backfill contra un documento real del corpus, edición del modal de Política reflejada en el chat), igual que el resto del pipeline de retrieval. Ojo con ese estilo de test: un `.replace()` para "restaurar" contenido después de pasar por un `<textarea>` real puede no matchear por normalización de saltos de línea del browser — pasó en esta sesión y dejó un texto de prueba pisando el real hasta corregirlo a mano; mejor comparar/reconstruir el valor completo que intentar un replace parcial sobre lo que devolvió el DOM.

## Desarrollo local

`wrangler dev` a secas **falla** con `Binding VECTORIZE needs to be run remotely` — Vectorize no se emula en Miniflare. Hace falta `wrangler dev --remote`, que a su vez requiere OAuth completo vía `wrangler login` (un `CLOUDFLARE_API_TOKEN` en el entorno no alcanza). Si no hay sesión interactiva disponible, la alternativa práctica es validar cada llamada por separado con `curl` (Gemini embed, Gemini generate, Vectorize query) y apoyarse en los unit tests — o, para cosas que solo se pueden ver en producción (el panel admin completo, el parseo client-side), desplegar y probar contra la URL real, revirtiendo si algo sale mal.

## Estilo

`.editorconfig` + `.prettierrc`: tabs, comillas simples, punto y coma, `printWidth: 140`.

## Cloudflare

Ver `AGENTS.md`: consultar la documentación vigente de Cloudflare antes de tocar Workers/KV/R2/Vectorize en vez de confiar en conocimiento previo, y correr `wrangler types` después de cambiar bindings en `wrangler.jsonc`.
