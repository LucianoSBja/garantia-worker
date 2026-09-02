// UI del panel admin — GarantIA. Mismo patrón que chatHTML() en index.js:
// un solo template string con <style>/<script> inline, sin build step.
//
// El parseo de archivos (PDF/DOCX/XLSX/PPTX -> texto) corre acá, en el
// navegador del admin, no en el Worker: la cuenta está en el plan Free de
// Cloudflare, con 10ms de CPU por request fijos y no configurables, y un
// PDF real del corpus (13MB) ya excede ese límite parseando server-side
// (medido, ver CLAUDE.md). El navegador no tiene ese límite.

export function adminHTML() {
	return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <title>GarantIA — Panel admin</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.2/mammoth.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --red: #EB0A1E;
      --red-dark: #c00018;
      --black: #1a1a1a;
      --gray-bg: #f4f4f4;
      --gray-border: #e0e0e0;
      --gray-text: #666;
      --white: #ffffff;
      --green: #1a8a3e;
      --shadow: 0 2px 8px rgba(0,0,0,0.08);
      --radius: 12px;
    }

    html, body {
      min-height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--gray-bg);
      color: var(--black);
    }

    .app { max-width: 900px; margin: 0 auto; padding: 16px; }

    .header {
      background: var(--red);
      border-radius: var(--radius);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      color: #fff;
    }
    .header h1 { font-size: 1.1rem; }
    .header button {
      background: rgba(255,255,255,.15);
      border: 1px solid rgba(255,255,255,.3);
      color: #fff;
      border-radius: 8px;
      padding: 6px 14px;
      font-size: .8rem;
      cursor: pointer;
    }

    .card {
      background: var(--white);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
      margin-bottom: 16px;
    }

    .card h2 { font-size: .95rem; margin-bottom: 12px; }

    /* ── Login ── */
    #vistaLogin { max-width: 360px; margin: 60px auto 0; }
    #vistaLogin input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--gray-border);
      border-radius: 8px;
      font-size: .95rem;
      margin-bottom: 10px;
    }
    #vistaLogin button {
      width: 100%;
      background: var(--red);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px;
      font-weight: 600;
      cursor: pointer;
    }
    #vistaLogin button:hover { background: var(--red-dark); }
    .error-msg { color: var(--red); font-size: .82rem; margin-bottom: 10px; min-height: 1.1em; }

    /* ── Upload ── */
    #formUpload { display: flex; flex-direction: column; gap: 10px; }
    #formUpload input[type="file"] { font-size: .85rem; }
    #formUpload button {
      background: var(--red);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px;
      font-weight: 600;
      cursor: pointer;
      align-self: flex-start;
      padding-left: 20px;
      padding-right: 20px;
    }
    #formUpload button:disabled { background: var(--gray-text); cursor: not-allowed; }

    #estadoJob {
      margin-top: 12px;
      font-size: .85rem;
      padding: 10px;
      border-radius: 8px;
      background: var(--gray-bg);
      display: none;
    }
    #estadoJob.visible { display: block; }
    #estadoJob.error { background: #fdecea; color: var(--red-dark); }
    #estadoJob.done { background: #e9f7ee; color: var(--green); }
    #estadoJob button {
      margin-top: 8px;
      background: var(--red);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: .8rem;
      cursor: pointer;
    }

    /* ── Tabla de archivos ── */
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--gray-border); }
    th { color: var(--gray-text); font-weight: 600; font-size: .75rem; text-transform: uppercase; }
    td.acciones { white-space: nowrap; }
    td.acciones button, td.acciones label {
      font-size: .75rem;
      border: 1px solid var(--gray-border);
      background: var(--white);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
      margin-right: 4px;
      display: inline-block;
    }
    td.acciones button.borrar { color: var(--red); border-color: var(--red); }
    td.acciones input[type="file"] { display: none; }
    a.link-drive { color: var(--red); text-decoration: none; }
    a.link-drive:hover { text-decoration: underline; }
    .vacio { color: var(--gray-text); font-size: .85rem; padding: 8px 0; }

    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div class="app">
    <div id="vistaLogin" hidden>
      <div class="card">
        <h2>Panel admin — GarantIA</h2>
        <p class="error-msg" id="loginError"></p>
        <input type="password" id="loginPassword" placeholder="Contraseña" autocomplete="current-password"/>
        <button id="btnLogin">Ingresar</button>
      </div>
    </div>

    <div id="vistaDashboard" hidden>
      <div class="header">
        <h1>Panel admin — GarantIA</h1>
        <button id="btnLogout">Cerrar sesión</button>
      </div>

      <div class="card">
        <h2>Subir documento</h2>
        <form id="formUpload">
          <input type="file" id="inputArchivo" accept=".pdf,.docx,.xlsx,.xls,.pptx"/>
          <button type="submit" id="btnSubir">Subir e indexar</button>
        </form>
        <div id="estadoJob"></div>
      </div>

      <div class="card">
        <h2>Documentos indexados</h2>
        <div id="listaArchivos"><p class="vacio">Cargando…</p></div>
      </div>
    </div>
  </div>

  <script type="module">
    // ── pdf.js: build ESM moderno, se carga como módulo dinámico ──
    const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs';

    const vistaLogin = document.getElementById('vistaLogin');
    const vistaDashboard = document.getElementById('vistaDashboard');
    const loginError = document.getElementById('loginError');
    const estadoJobEl = document.getElementById('estadoJob');
    const listaArchivosEl = document.getElementById('listaArchivos');

    let polling = null;

    // ── Parsers client-side ──────────────────────────────────
    // Mismo criterio que src/ingest.js (documentado en CLAUDE.md), portado
    // al navegador porque acá no hay límite de CPU de Workers.

    // El orden que da getTextContent() por sí solo alcanza para documentos
    // simples, pero no para todos: probado contra un boletín real (ABI-511)
    // salía con el pie de página legal primero, igual que le pasaba a
    // pdf2json sin ordenarPagina() (ver CLAUDE.md). Reordenamos por
    // coordenadas, mismo criterio que ordenarPagina() en src/ingest.js,
    // adaptado a item.transform (pdf.js da [a,b,c,d,x,y]; el eje Y crece
    // hacia arriba, así que "arriba de la página" es Y más grande).
    const TOLERANCIA_LINEA_PDFJS = 3;

    function ordenarPaginaPdfjs(items) {
      const conPos = items.map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
      const lineas = [];
      for (const item of conPos.sort((a, b) => b.y - a.y || a.x - b.x)) {
        const ultima = lineas[lineas.length - 1];
        if (ultima && Math.abs(ultima.y - item.y) <= TOLERANCIA_LINEA_PDFJS) ultima.items.push(item);
        else lineas.push({ y: item.y, items: [item] });
      }
      return lineas
        .map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\\n');
    }

    async function parsePdfBrowser(arrayBuffer) {
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let texto = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        texto += ordenarPaginaPdfjs(content.items) + '\\n';
      }
      return texto;
    }

    async function parseDocxBrowser(arrayBuffer) {
      const res = await mammoth.extractRawText({ arrayBuffer });
      return res.value;
    }

    const VIN_RE = /\\b[A-HJ-NPR-Z0-9]{17}\\b/;

    function parseXlsxBrowser(arrayBuffer) {
      const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
      let texto = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        texto += \`\\n## Hoja: \${sheetName}\\n\`;
        let omitidas = 0;
        for (const row of rows) {
          const line = row.filter(Boolean).join(' | ');
          if (!line.trim()) continue;
          if (VIN_RE.test(line)) { omitidas++; continue; }
          texto += line + '\\n';
        }
        if (omitidas > 0) texto += \`(\${omitidas} vehículos alcanzados, listado de VIN omitido del índice)\\n\`;
      }
      return texto;
    }

    async function parsePptxBrowser(arrayBuffer) {
      const zip = await JSZip.loadAsync(arrayBuffer);
      const numero = (n) => Number(n.match(/(\\d+)\\.xml$/)[1]);
      const partes = Object.keys(zip.files)
        .filter((n) => /^ppt\\/(slides|notesSlides)\\/[a-zA-Z]+\\d+\\.xml$/.test(n))
        .sort((a, b) => numero(a) - numero(b));
      let texto = '';
      for (const parte of partes) {
        const xml = await zip.file(parte).async('string');
        const frases = [...xml.matchAll(/<a:t>([^<]*)<\\/a:t>/g)].map((m) => m[1]);
        if (frases.length > 0) texto += frases.join(' ') + '\\n';
      }
      return texto;
    }

    async function parsearArchivo(file) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const buf = await file.arrayBuffer();
      if (ext === '.pdf') return parsePdfBrowser(buf);
      if (ext === '.docx') return parseDocxBrowser(buf);
      if (ext === '.xlsx' || ext === '.xls') return parseXlsxBrowser(buf);
      if (ext === '.pptx') return parsePptxBrowser(buf);
      throw new Error('Formato no soportado: ' + ext);
    }

    // ── Auth ──────────────────────────────────────────────────

    async function mostrarLogin(mensaje) {
      vistaDashboard.hidden = true;
      vistaLogin.hidden = false;
      loginError.textContent = mensaje || '';
    }

    async function mostrarDashboard() {
      vistaLogin.hidden = true;
      vistaDashboard.hidden = false;
      await cargarArchivos();
    }

    async function verificarSesion() {
      const res = await fetch('/admin/api/files');
      if (res.status === 401) return mostrarLogin();
      return mostrarDashboard();
    }

    document.getElementById('btnLogin').addEventListener('click', async () => {
      const password = document.getElementById('loginPassword').value;
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        document.getElementById('loginPassword').value = '';
        return mostrarDashboard();
      }
      const data = await res.json().catch(() => ({}));
      loginError.textContent = data.error || 'No se pudo iniciar sesión';
    });

    document.getElementById('btnLogout').addEventListener('click', async () => {
      await fetch('/admin/logout', { method: 'POST' });
      if (polling) clearInterval(polling);
      mostrarLogin();
    });

    // ── Archivos ──────────────────────────────────────────────

    async function cargarArchivos() {
      const res = await fetch('/admin/api/files');
      if (res.status === 401) return mostrarLogin();
      const { archivos, job } = await res.json();
      renderizarLista(archivos);
      renderizarEstadoJob(job);
      if (job.estado === 'embedding') iniciarPolling();
    }

    function renderizarLista(archivos) {
      const nombres = Object.keys(archivos).sort();
      if (nombres.length === 0) {
        listaArchivosEl.innerHTML = '<p class="vacio">Todavía no se subió ningún documento desde acá.</p>';
        return;
      }

      const filas = nombres
        .map((nombre) => {
          const info = archivos[nombre];
          const fecha = info.subidoEl ? new Date(info.subidoEl).toLocaleDateString('es-AR') : '—';
          return \`<tr>
            <td>\${escaparHTML(nombre)}</td>
            <td>\${info.chunks}</td>
            <td>\${fecha}</td>
            <td>\${info.driveUrl ? \`<a class="link-drive" href="\${escaparHTML(info.driveUrl)}" target="_blank" rel="noopener">Ver</a>\` : '—'}</td>
            <td class="acciones">
              <label>Reemplazar<input type="file" class="inputReemplazo" data-nombre="\${escaparHTML(nombre)}" accept=".pdf,.docx,.xlsx,.xls,.pptx"/></label>
              <button class="borrar" data-nombre="\${escaparHTML(nombre)}">Eliminar</button>
            </td>
          </tr>\`;
        })
        .join('');

      listaArchivosEl.innerHTML = \`<table>
        <thead><tr><th>Archivo</th><th>Fragmentos</th><th>Subido</th><th>Drive</th><th>Acciones</th></tr></thead>
        <tbody>\${filas}</tbody>
      </table>\`;

      listaArchivosEl.querySelectorAll('button.borrar').forEach((btn) => {
        btn.addEventListener('click', () => eliminarArchivo(btn.dataset.nombre));
      });
      listaArchivosEl.querySelectorAll('.inputReemplazo').forEach((input) => {
        input.addEventListener('change', () => {
          if (input.files[0]) subirArchivo(input.files[0], input.dataset.nombre);
        });
      });
    }

    function escaparHTML(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function eliminarArchivo(nombre) {
      if (!confirm(\`¿Eliminar "\${nombre}" del índice? Esto lo saca de las respuestas del chat.\`)) return;
      const res = await fetch(\`/admin/api/files/\${encodeURIComponent(nombre)}/delete\`, { method: 'POST' });
      if (res.status === 401) return mostrarLogin();
      await cargarArchivos();
    }

    // ── Subida ────────────────────────────────────────────────

    document.getElementById('formUpload').addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = document.getElementById('inputArchivo').files[0];
      if (!file) return;
      await subirArchivo(file, null);
      document.getElementById('inputArchivo').value = '';
    });

    async function subirArchivo(file, nombreAReemplazar) {
      const btnSubir = document.getElementById('btnSubir');
      btnSubir.disabled = true;
      renderizarEstadoJob({ estado: 'parseando', mensaje: 'Extrayendo texto del archivo en el navegador…' });

      try {
        const texto = await parsearArchivo(file);
        if (!texto.trim()) throw new Error('No se pudo extraer texto de este archivo.');

        const form = new FormData();
        form.append('fileName', nombreAReemplazar || file.name);
        form.append('mimeType', file.type || '');
        form.append('text', texto);
        form.append('file', file, nombreAReemplazar || file.name);

        const res = await fetch('/admin/api/upload', { method: 'POST', body: form });
        if (res.status === 401) return mostrarLogin();
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo iniciar la subida');

        renderizarEstadoJob({ estado: 'embedding', nextIndex: 0, total: data.total });
        iniciarPolling();
      } catch (err) {
        renderizarEstadoJob({ estado: 'error', error: err.message });
        btnSubir.disabled = false;
      }
    }

    function iniciarPolling() {
      if (polling) clearInterval(polling);
      polling = setInterval(async () => {
        const res = await fetch('/admin/api/upload/status');
        if (res.status === 401) { clearInterval(polling); return mostrarLogin(); }
        const job = await res.json();
        renderizarEstadoJob(job);
        if (job.estado === 'done' || job.estado === 'error' || job.estado === 'inactivo') {
          clearInterval(polling);
          polling = null;
          document.getElementById('btnSubir').disabled = false;
          if (job.estado === 'done') await cargarArchivos();
        }
      }, 2500);
    }

    function renderizarEstadoJob(job) {
      estadoJobEl.className = 'visible';
      if (job.estado === 'parseando') {
        estadoJobEl.textContent = job.mensaje;
      } else if (job.estado === 'embedding') {
        estadoJobEl.textContent = \`Indexando "\${job.fileName || ''}": \${job.nextIndex ?? 0} / \${job.total ?? '?'} fragmentos…\`;
      } else if (job.estado === 'done') {
        estadoJobEl.className = 'visible done';
        estadoJobEl.textContent = \`Listo: "\${job.fileName}" indexado (\${job.total} fragmentos).\`;
      } else if (job.estado === 'error') {
        estadoJobEl.className = 'visible error';
        estadoJobEl.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = 'Error: ' + (job.error || 'desconocido');
        estadoJobEl.appendChild(p);
        const btn = document.createElement('button');
        btn.textContent = 'Reintentar';
        btn.addEventListener('click', reintentarJob);
        estadoJobEl.appendChild(btn);
      } else {
        estadoJobEl.className = '';
      }
    }

    async function reintentarJob() {
      const res = await fetch('/admin/api/upload/retry', { method: 'POST' });
      if (res.status === 401) return mostrarLogin();
      const data = await res.json();
      if (res.ok) {
        document.getElementById('btnSubir').disabled = true;
        renderizarEstadoJob({ estado: 'embedding', nextIndex: data.nextIndex, total: data.total });
        iniciarPolling();
      }
    }

    verificarSesion();
  </script>
</body>
</html>`;
}
