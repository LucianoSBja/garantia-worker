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
│  Embedding      │  @cf/baai/bge-m3 (multilingüe)
│  de la consulta │
└────────┬────────┘
         │ vector
         ▼
┌─────────────────┐
│  Vectorize      │  Búsqueda semántica en 742+ fragmentos
│  (RAG)          │
└────────┬────────┘
         │ contexto relevante
         ▼
┌─────────────────┐
│  Llama 3.1 8B   │  @cf/meta/llama-3.1-8b-instruct
│  (LLM)          │
└────────┬────────┘
         │ respuesta citada
         ▼
┌─────────────────┐
│  KV Cache       │  Respuestas frecuentes cacheadas 1h
└─────────────────┘
```
 
**Servicios utilizados (todos en plan gratuito de Cloudflare):**
 
| Servicio | Uso | Límite gratuito |
|---|---|---|
| Cloudflare Workers | Lógica principal / chat web | 100.000 req/día |
| Cloudflare Vectorize | Base vectorial RAG | 30M vectores |
| Workers AI | Embeddings + LLM (Llama 3.1) | 10.000 neurons/día |
| Cloudflare R2 | Almacenamiento de documentos | 10 GB |
| Cloudflare KV | Caché de respuestas | 100.000 lecturas/día |
 
**Costo total: $0**
 
---
 
## Estructura del proyecto
 
```
garantia-worker/
├── src/
│   ├── index.js          # Worker principal (chat + RAG + LLM)
│   ├── ingest.js         # Ingesta masiva de carpetas (PDF + Excel)
│   └── ingest_file.js    # Ingesta de archivo individual
├── docs/                 # Documentos de garantías (no incluido en git)
├── wrangler.jsonc        # Configuración de Cloudflare
├── .env                  # Variables de entorno (no incluido en git)
├── package.json
└── README.md
```
 
---
 
## Instalación y configuración
 
### Requisitos
 
- Node.js v18+
- pnpm
- Cuenta en Cloudflare (gratuita)
### 1. Clonar e instalar
 
```bash
git clone https://github.com/TU_USUARIO/garantia-worker.git
cd garantia-worker
pnpm install
pnpm approve-builds  # aprobar esbuild y workerd
```
 
### 2. Configurar variables de entorno
 
Crear el archivo `.env`:
 
```env
CLOUDFLARE_ACCOUNT_ID="tu-account-id"
CLOUDFLARE_API_TOKEN="tu-api-token"
CF_ACCOUNT_ID="tu-account-id"
CF_API_TOKEN="tu-api-token"
```
 
Obtener el `ACCOUNT_ID` desde el dashboard de Cloudflare.
Crear el `API_TOKEN` en **My Profile → API Tokens → Create Token** con permisos de Workers, Vectorize, R2, KV y AI.
 
### 3. Crear los recursos en Cloudflare
 
```bash
# Autenticarse
wrangler login
 
# Crear índice vectorial (1024 dimensiones para bge-m3)
wrangler vectorize create garantia-index --dimensions=1024 --metric=cosine
 
# Crear bucket R2 para documentos
wrangler r2 bucket create garantia-docs
 
# Crear namespace KV para caché
wrangler kv namespace create garantia-cache
```
 
Copiar el ID del KV al `wrangler.jsonc`.
 
### 4. Indexar documentos
 
Poner los PDFs y Excel en la carpeta `docs/` (puede tener subcarpetas) y ejecutar:
 
```bash
# Cargar variables
set -a && source .env && set +a
 
# Indexar toda la carpeta docs/
node src/ingest.js ./docs
 
# O indexar un archivo individual
node src/ingest_file.js docs/mi-documento.pdf
```
 
### 5. Desarrollo local
 
```bash
wrangler dev --remote
```
 
Abrir `http://localhost:8787` en el navegador.
 
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
| PDF (escaneado / imagen) | ❌ No soportado (requiere OCR) |
 
---
 
## Stack tecnológico
 
- **Runtime:** Cloudflare Workers (JavaScript ESM)
- **LLM:** Llama 3.1 8B Instruct (`@cf/meta/llama-3.1-8b-instruct`)
- **Embeddings:** BGE-M3 multilingüe (`@cf/baai/bge-m3`)
- **Base vectorial:** Cloudflare Vectorize
- **Almacenamiento:** Cloudflare R2
- **Caché:** Cloudflare KV
- **PDF parser:** pdf2json
- **Excel parser:** xlsx (SheetJS)
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
 
*Desarrollado con Cloudflare Workers + Workers AI — Costo de infraestructura: $0/mes*
