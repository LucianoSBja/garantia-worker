# GarantIA ⚡
### Asistente de garantías Toyota — Derka y Vargas, Sáenz Peña
 
Sistema de inteligencia artificial para consulta interna de garantías y boletines técnicos Toyota. Permite a técnicos y asesores de servicio resolver dudas en segundos, sin buscar manualmente en carpetas o correos.
 
---
 
## ¿Qué hace?
 
El técnico abre el chat en el navegador, escribe su pregunta en lenguaje natural, y GarantIA responde con información precisa extraída de los documentos oficiales, citando siempre la fuente.
 
**Ejemplo:**
> **Técnico:** ¿Qué cubre la garantía de baterías Toyota?
>
> **GarantIA:** La garantía cubre la batería de arranque y la batería de carga auxiliar, siempre que sean nuevas o tengan menos de 6 meses de uso. El cable de alimentación debe tener sección mínima de 22 mm². La garantía **no cubre** la batería auxiliar en vehículos con sistema ECB.
> 📄 Basado en: APLICACION DE GARANTIA EN BATERIAS.pdf
 
---
 
## Arquitectura
 
```
Técnico / Asesor
       │
       ▼
┌─────────────────┐
│  Chat Web       │  Cloudflare Workers (src/index.js)
│  (navegador)    │
└────────┬────────┘
         │ pregunta
         ▼
┌─────────────────┐
│  Embedding      │  Gemini gemini-embedding-001 (768 dims)
│  de la consulta │  taskType: RETRIEVAL_QUERY
└────────┬────────┘
         │ vector
         ▼
┌─────────────────┐
│  Vectorize      │  Búsqueda semántica (topK 5, score > 0.55)
│  (RAG)          │
└────────┬────────┘
         │ contexto relevante
         ▼
┌─────────────────┐
│  Gemini         │  gemini-3.5-flash-lite
│  (LLM)          │  temperature 0.2
└────────┬────────┘
         │ respuesta citada
         ▼
┌─────────────────┐
│  KV Cache       │  Respuestas frecuentes cacheadas 1h
└─────────────────┘
```
 
**Servicios utilizados:**
 
| Servicio | Uso | Límite gratuito |
|---|---|---|
| Cloudflare Workers | Lógica principal / chat web | 100.000 req/día |
| Cloudflare Vectorize | Base vectorial RAG | 30M vectores |
| Google Gemini API | Embeddings + LLM | Según cuota de Google AI Studio |
| Cloudflare KV | Caché de respuestas | 100.000 lecturas/día |
 
### Embeddings asimétricos
 
La ingesta y la consulta usan **task types distintos** del mismo modelo: `RETRIEVAL_DOCUMENT` al indexar los fragmentos y `RETRIEVAL_QUERY` al embeber la pregunta del técnico. Gemini optimiza cada lado por separado, lo que mejora el recall frente a un embedding simétrico. **No son intercambiables**: usar el mismo task type en ambos lados degrada la búsqueda.
 
### Caché
 
El caché KV se consulta y se escribe **solo cuando el historial está vacío** (primer mensaje de la conversación). Las repreguntas dependen del contexto previo, así que cachearlas por texto devolvería respuestas incorrectas.
 
### Qué queda fuera del índice
 
Los anexos de campañas traen planillas con miles de filas de VIN (números de chasis). Esas filas **no se indexan**: cada VIN es una cadena aleatoria, así que sus vectores salen casi idénticos entre sí y no aportan nada a una búsqueda semántica, además de inflar el índice. Se conservan los encabezados, que son los que describen la campaña, más una línea con el total de vehículos alcanzados.
 
La contrapartida es que GarantIA **no puede responder** "¿el chasis X entra en la campaña ABI-502?". Esa es una búsqueda exacta, no semántica, y se resolvería con un mapa VIN→campaña en KV.
 
---
 
## Estructura del proyecto
 
```
garantia-worker/
├── src/
│   ├── index.js          # Worker principal (chat + RAG + LLM + UI)
│   ├── ingest.js         # Ingesta masiva de carpetas (PDF + Excel + DOCX)
│   ├── ingest_file.js    # Ingesta de archivo individual
│   └── google_auth.js    # Autorización OAuth de Google Drive (se corre una vez)
├── test/unit/            # Tests unitarios (vitest, sin credenciales)
├── docs/                 # Documentos de garantías (no incluido en git)
├── wrangler.jsonc        # Configuración de Cloudflare
├── .env                  # Credenciales para los scripts de ingesta (no incluido en git)
├── .dev.vars             # Secrets para wrangler dev (no incluido en git)
├── package.json
└── README.md
```
 
---
 
## Instalación y configuración
 
### Requisitos
 
- Node.js v18+
- pnpm
- Cuenta en Cloudflare (gratuita)
- API key de [Google AI Studio](https://aistudio.google.com/apikey)
### 1. Clonar e instalar
 
```bash
git clone https://github.com/TU_USUARIO/garantia-worker.git
cd garantia-worker
pnpm install
pnpm approve-builds  # aprobar esbuild y workerd
```
 
### 2. Configurar variables de entorno
 
Hay tres lugares distintos según quién lea el secret:
 
**`.env`** — lo usan los scripts de ingesta que corren en Node:
 
```env
CLOUDFLARE_ACCOUNT_ID="tu-account-id"
CLOUDFLARE_API_TOKEN="tu-api-token"
CF_ACCOUNT_ID="tu-account-id"
CF_API_TOKEN="tu-api-token"
GOOGLE_API_KEY="tu-api-key-de-google-ai-studio"
 
# Solo para la integración con Google Drive (ver src/google_auth.js)
GOOGLE_OAUTH_CLIENT_ID="tu-client-id"
GOOGLE_OAUTH_CLIENT_SECRET="tu-client-secret"
GOOGLE_REFRESH_TOKEN="lo-imprime-google_auth.js"
```
 
**`.dev.vars`** — lo lee `wrangler dev`:
 
```env
GOOGLE_API_KEY=tu-api-key-de-google-ai-studio
```
 
**Producción** — el Worker desplegado:
 
```bash
wrangler secret put GOOGLE_API_KEY
```
 
Obtener el `ACCOUNT_ID` desde el dashboard de Cloudflare.
Crear el `API_TOKEN` en **My Profile → API Tokens → Create Token** con permisos de Workers, Vectorize y KV.
Crear la API key de Gemini en **Google AI Studio → Get API key**.
 
### 3. Crear los recursos en Cloudflare
 
```bash
# Autenticarse
wrangler login
 
# Crear índice vectorial (768 dimensiones para gemini-embedding-001)
wrangler vectorize create garantia-index-gemini --dimensions=768 --metric=cosine
 
# Crear namespace KV para caché
wrangler kv namespace create garantia-cache
```
 
Copiar el ID del KV al `wrangler.jsonc`.
 
> Las 768 dimensiones están atadas al modelo de embeddings. Vectorize no permite cambiarlas sobre un índice existente: si se cambia de modelo, hay que crear un índice nuevo y re-indexar todo.
 
### 4. Indexar documentos
 
Poner los PDFs, Excel y Word en la carpeta `docs/` (puede tener subcarpetas) y ejecutar:
 
```bash
# Cargar variables
set -a && source .env && set +a
 
# Indexar toda la carpeta docs/
node src/ingest.js ./docs
 
# O indexar un archivo individual
node src/ingest_file.js docs/mi-documento.pdf
```
 
Los IDs de los vectores son determinísticos (`archivo-fragmento`), así que re-indexar el mismo documento sobreescribe en lugar de duplicar.
 
`ingest.js` anota cada archivo terminado en `.ingest-checkpoint.json`, así que una corrida cortada retoma donde quedó en vez de volver a embeber todo. Ante un `429` de Gemini reintenta con backoff exponencial (5s, 10s, 20s, 40s, 80s) y, entre fragmento y fragmento, espera 700 ms para no pasarse del límite de 100 requests por minuto.
 
> La cuota gratuita de Gemini corta a los 1.000 embeddings diarios y se resetea a la medianoche del Pacífico (4 de la mañana en Argentina). Si una corrida larga se queda sin cuota, se retoma al día siguiente sin repetir trabajo. Para rehacer todo desde cero hay que borrar el checkpoint.
 
### 5. Desarrollo local
 
```bash
wrangler dev --remote
```
 
Abrir `http://localhost:8787` en el navegador.
 
El flag `--remote` es obligatorio: Vectorize no se emula localmente y `wrangler dev` a secas falla con `Binding VECTORIZE needs to be run remotely`. Requiere `wrangler login` (sesión OAuth interactiva — un `CLOUDFLARE_API_TOKEN` en el entorno no alcanza).
 
### 5b. Tests
 
```bash
pnpm test
```
 
Corren en Node con `fetch` y los bindings mockeados, sin necesidad de credenciales ni del runtime de Workers.
 
### 6. Deploy a producción
 
```bash
wrangler deploy
```
 
La URL pública queda en el formato: `https://garantia-worker.TU_USUARIO.workers.dev`
 
---
 
## Agregar nuevos documentos
 
Cuando llegue un nuevo boletín o documento:
 
```bash
set -a && source .env && set +a
node src/ingest_file.js "docs/NUEVO_DOCUMENTO.pdf"
```
 
Vectorize tarda 1-2 minutos en procesar los nuevos vectores.
 
---
 
## Formatos soportados
 
| Formato | Soporte |
|---|---|
| PDF (texto) | ✅ Completo |
| Excel (.xlsx / .xls) | ✅ Completo |
| Word (.docx) | ✅ Completo |
| PDF (escaneado / imagen) | ❌ No soportado (requiere OCR) |
 
---
 
## Stack tecnológico
 
- **Runtime:** Cloudflare Workers (JavaScript ESM)
- **LLM:** Gemini 3.5 Flash Lite (`gemini-3.5-flash-lite`)
- **Embeddings:** Gemini (`gemini-embedding-001`, 768 dimensiones)
- **Base vectorial:** Cloudflare Vectorize
- **Caché:** Cloudflare KV
- **PDF parser:** pdf2json
- **Excel parser:** xlsx (SheetJS)
- **Word parser:** mammoth
- **Tests:** vitest
---
 
## Prompt del sistema
 
GarantIA está configurada para:
- Responder **siempre con fuente citada** (nombre del documento)
- Mencionar el **modelo de vehículo y número de boletín** cuando estén disponibles
- **Derivar al responsable** cuando no encuentra información en la base
- **No inventar** coberturas, plazos ni procedimientos
- Detectar y mencionar **contradicciones** entre documentos
---
 
## Proyecto
 
**Cliente:** Derka y Vargas — Concesionario oficial Toyota, Sáenz Peña, Chaco  
**Área:** Taller / Posventa  
**Versión:** 1.0.0  
**Fecha:** Mayo 2026
 
---
 
*Desarrollado con Cloudflare Workers + Google Gemini*
