// UI del panel admin — GarantIA. Mismo patrón que chatHTML() en index.js:
// un solo template string con <style>/<script> inline, sin build step.
//
// El parseo de archivos (PDF/DOCX/XLSX/PPTX -> texto) corre acá, en el
// navegador del admin, no en el Worker: la cuenta está en el plan Free de
// Cloudflare, con 10ms de CPU por request fijos y no configurables, y un
// PDF real del corpus (13MB) ya excede ese límite parseando server-side
// (medido, ver CLAUDE.md). El navegador no tiene ese límite.
//
// Paleta: el rojo Toyota queda como marca (header) y como color destructivo
// (borrar) — son el mismo rojo a propósito, "esto es serio" en los dos
// casos. Las acciones primarias (subir, confirmar, guardar) usan un azul
// aparte para no competir con esa señal. Gris para lo secundario.

export function adminHTML() {
	return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <title>GarantIA — Panel admin</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.2/mammoth.browser.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --red: #EB0A1E;
      --red-dark: #B5000F;
      --red-bg: #FDECEC;
      --blue: #1D4ED8;
      --blue-dark: #1739A6;
      --blue-bg: #EEF2FF;
      --green: #15803D;
      --green-bg: #ECFDF3;
      --amber: #B45309;
      --amber-bg: #FFFBEB;
      --ink: #16181D;
      --gray-700: #4B5563;
      --gray-500: #6B7280;
      --gray-300: #D8DCE3;
      --gray-100: #F1F2F5;
      --page-bg: #F6F7F9;
      --white: #ffffff;
      --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
      --shadow-lg: 0 8px 28px rgba(16,24,40,.16);
      --radius: 14px;
      --radius-sm: 8px;
      --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
    }

    html, body {
      min-height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--page-bg);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }

    .app {
      max-width: 960px; margin: 0 auto;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }

    button { font: inherit; }

    /* ── Botones ── */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      border: 1px solid transparent; border-radius: var(--radius-sm);
      padding: 9px 16px; font-size: .85rem; font-weight: 600; cursor: pointer;
      transition: background .12s, border-color .12s, opacity .12s;
    }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .btn-primario { background: var(--blue); color: #fff; }
    .btn-primario:hover:not(:disabled) { background: var(--blue-dark); }
    .btn-destructivo { background: var(--red); color: #fff; }
    .btn-destructivo:hover:not(:disabled) { background: var(--red-dark); }
    .btn-secundario { background: var(--white); color: var(--gray-700); border-color: var(--gray-300); }
    .btn-secundario:hover:not(:disabled) { background: var(--gray-100); }
    .btn-texto { background: none; color: var(--blue); padding: 4px 2px; font-size: .82rem; }
    .btn-texto:hover { text-decoration: underline; }
    .btn-sm { padding: 5px 11px; font-size: .76rem; }
    .btn-icono { padding: 5px 9px; }
    /* En mobile solo se ve el ícono (el title/aria-label cubren
       accesibilidad y el "tooltip" nativo al mantener presionado); desde
       tablet en adelante se agrega el texto — mismo breakpoint que tabla
       -> tarjetas, para que ambos cambios de densidad coincidan. */
    .texto-accion { display: none; }
    /* El texto del botón depende del ancho REAL disponible para la tarjeta,
       no del viewport: con la sidebar fija (>860px) el ancho disponible ya
       no es "pantalla completa" — a 1024px de viewport la tarjeta tiene
       ~700px, no le entran tres botones con texto y desborda (medido).
       Container query en vez de @media: se prende según el ancho de .card,
       así funciona igual con sidebar abierta o cerrada. Si el navegador no
       soporta container queries, se queda en solo-ícono — nunca desborda. */
    .card { container-type: inline-size; }
    @container (min-width: 1000px) {
      .btn-icono { padding: 5px 12px; gap: 5px; }
      .texto-accion { display: inline; }
    }

    /* ── Layout con sidebar (item 7) ── */
    /* Ancho completo a propósito, sin tope — un tope fijo (se probó 1440px)
       seguía dejando franjas vacías a los costados en un monitor grande. El
       padding de .main de acá abajo es lo único que separa el contenido de
       los bordes de la ventana. */
    .app-shell { display: flex; align-items: flex-start; width: 100%; }
    .sidebar {
      width: 224px; flex-shrink: 0;
      display: flex; flex-direction: column;
      padding: 20px 12px; gap: 2px;
      min-height: 100vh;
      border-right: 1px solid var(--gray-300);
      background: var(--white);
    }
    .sidebar-brand {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px 18px; font-weight: 700; font-size: .95rem;
    }
    .sidebar-brand .icono { color: var(--red); font-size: 1.15rem; }
    .nav-item {
      display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      border: none; background: none; border-radius: var(--radius-sm);
      padding: 10px 12px; font-size: .86rem; font-weight: 600; color: var(--gray-700); cursor: pointer;
    }
    .nav-item:hover { background: var(--gray-100); }
    .nav-item.activo { background: var(--blue-bg); color: var(--blue-dark); }
    .sidebar-footer { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--gray-100); }
    .sidebar-footer .btn { width: 100%; }
    .sidebar-overlay { display: none; }

    .main { flex: 1; min-width: 0; padding: 20px 24px 60px; }
    @media (min-width: 1100px) { .main { padding: 28px 40px 60px; } }
    .topbar {
      display: flex; align-items: center; gap: 12px;
      background: var(--red); color: #fff; border-radius: var(--radius);
      padding: 14px 18px; margin-bottom: 18px;
    }
    .topbar h1 { font-size: 1rem; font-weight: 700; flex: 1; }
    .topbar .btn-secundario { background: rgba(255,255,255,.14); color: #fff; border-color: rgba(255,255,255,.32); }
    .topbar .hamburguesa { display: none; }
    .hamburguesa {
      background: none; border: none; color: #fff; font-size: 1.3rem; cursor: pointer;
      width: 44px; height: 44px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: 8px;
    }
    .hamburguesa:hover { background: rgba(255,255,255,.14); }

    @media (max-width: 1140px) {
      .sidebar {
        position: fixed; inset: 0 auto 0 0; width: 260px; z-index: 150;
        transform: translateX(-100%); transition: transform .2s ease;
        box-shadow: var(--shadow-lg);
      }
      .sidebar.abierto { transform: translateX(0); }
      .sidebar-overlay {
        display: block; position: fixed; inset: 0; background: rgba(16,20,28,.45); z-index: 140;
        opacity: 0; pointer-events: none; transition: opacity .2s;
      }
      .sidebar-overlay.visible { opacity: 1; pointer-events: auto; }
      .main { padding: 14px 12px 60px; }
      .topbar .hamburguesa { display: flex; }
    }

    .card {
      background: var(--white);
      border: 1px solid var(--gray-300);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 22px;
      margin-bottom: 18px;
    }
    .card h2 { font-size: .92rem; font-weight: 700; margin-bottom: 4px; }
    .card .card-sub { color: var(--gray-500); font-size: .8rem; margin-bottom: 14px; }

    /* ── Vistas de auth (login / recuperar / reset) ── */
    /* Centrado vertical y horizontal lo da .app (flex + min-height:100dvh),
       así que acá no hace falta margin propio — solo el ancho máximo de
       la tarjeta. */
    .auth-shell { max-width: 380px; width: 100%; }
    .auth-shell .card { text-align: left; }
    .auth-brand {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      background: var(--red); color: #fff; border-radius: var(--radius);
      padding: 14px 20px; margin-bottom: 16px; font-weight: 700; font-size: 1.05rem;
      max-width: 380px; width: 100%;
    }
    .auth-brand .icono { font-size: 1.25rem; line-height: 1; }
    .auth-shell h2 { font-size: 1rem; }
    .campo { margin-bottom: 12px; }
    .campo label { display: block; font-size: .78rem; font-weight: 600; color: var(--gray-700); margin-bottom: 5px; }
    .campo input {
      width: 100%; padding: 10px 12px; border: 1px solid var(--gray-300); border-radius: var(--radius-sm);
      font-size: .92rem; background: var(--white); color: var(--ink);
    }
    .campo input:focus { outline: 2px solid var(--blue); outline-offset: 1px; border-color: var(--blue); }
    .auth-shell .btn { width: 100%; margin-top: 4px; }
    .auth-links { margin-top: 14px; text-align: center; font-size: .82rem; }
    .error-msg { color: var(--red); font-size: .82rem; margin-bottom: 10px; min-height: 1.1em; }
    .info-msg { color: var(--green); font-size: .82rem; margin-bottom: 10px; min-height: 1.1em; }

    /* ── Tarjeta informativa (item 3) ── */
    .info-alert {
      display: flex; gap: 10px; align-items: flex-start;
      background: var(--blue-bg); border: 1px solid #C7D6FB; border-radius: var(--radius-sm);
      padding: 12px 14px; margin-bottom: 16px; font-size: .82rem; color: #1E3A8A; line-height: 1.45;
    }
    .info-alert .icono { font-size: 1rem; line-height: 1; flex-shrink: 0; }

    /* ── Subida ── */
    #formUpload { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
    #formUpload input[type="file"] { font-size: .85rem; width: 100%; }

    .estado-job {
      margin-top: 4px; font-size: .84rem; padding: 11px 13px; border-radius: var(--radius-sm);
      background: var(--gray-100); display: none; width: 100%;
    }
    .estado-job.visible { display: block; }
    .estado-job.error { background: var(--red-bg); color: var(--red-dark); }
    .estado-job.done { background: var(--green-bg); color: var(--green); }
    .estado-job .btn { margin-top: 8px; }

    /* ── Política: vista previa / edición ── */
    .politica-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
    .politica-header .card-sub { margin-bottom: 0; }
    .politica-acciones { display: flex; gap: 8px; margin-top: 12px; }
    .politica-preview {
      border: 1px solid var(--gray-300); border-radius: var(--radius-sm);
      padding: 16px 18px; font-size: .86rem; line-height: 1.6; color: var(--ink);
      max-height: 480px; overflow-y: auto;
    }
    .politica-preview h2, .politica-preview h3 { font-size: .92rem; font-weight: 700; color: var(--red); margin: 16px 0 8px; }
    .politica-preview h2:first-child, .politica-preview h3:first-child { margin-top: 0; }
    .politica-preview p { margin: 0 0 10px; }
    .politica-preview ul, .politica-preview ol { margin: 0 0 12px; padding-left: 20px; }
    .politica-preview li { margin-bottom: 6px; }
    .politica-preview table { width: 100%; border-collapse: collapse; margin: 4px 0 12px; font-size: .8rem; }
    .politica-preview th, .politica-preview td { border: 1px solid var(--gray-300); padding: 6px 8px; text-align: left; }
    .politica-preview th { background: var(--gray-100); font-weight: 700; }
    .politica-preview blockquote { font-size: .8rem; color: var(--gray-700); background: var(--gray-100); border-radius: 8px; padding: 8px 10px; margin: 0 0 12px; }
    .politica-preview hr { border: none; border-top: 1px solid var(--gray-100); margin: 10px 0; }

    /* ── Tabs + buscador ── */
    .tabla-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
    .tabs { display: flex; gap: 4px; background: var(--gray-100); border-radius: var(--radius-sm); padding: 3px; }
    .tab {
      border: none; background: none; padding: 6px 14px; font-size: .82rem; font-weight: 600;
      color: var(--gray-700); border-radius: 6px; cursor: pointer;
    }
    .tab.activo { background: var(--white); color: var(--ink); box-shadow: var(--shadow); }
    .buscador { position: relative; flex: 1; min-width: 180px; max-width: 280px; }
    .buscador input {
      width: 100%; padding: 7px 12px 7px 30px; border: 1px solid var(--gray-300); border-radius: var(--radius-sm);
      font-size: .84rem;
    }
    .buscador::before {
      content: '⌕'; position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--gray-500); font-size: .95rem;
    }

    /* ── Tabla de archivos ── */
    .tabla-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .84rem; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--gray-100); white-space: nowrap; }
    th:first-child, td:first-child { white-space: normal; }
    th { color: var(--gray-500); font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; }
    td.fecha, td.chunks { font-family: var(--mono); font-size: .78rem; color: var(--gray-700); }
    td.acciones { text-align: right; }
    td.acciones .btn { margin-left: 6px; }
    a.link-drive { color: var(--blue); text-decoration: none; font-weight: 600; }
    a.link-drive:hover { text-decoration: underline; }
    .vacio { color: var(--gray-500); font-size: .85rem; padding: 18px 4px; text-align: center; }

    /* ── Paginador ── */
    .paginador { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 14px; }
    .paginador-info { font-size: .8rem; color: var(--gray-500); font-family: var(--mono); }

    tr.fila-pendiente { background: linear-gradient(90deg, transparent, rgba(180,83,9,.05), transparent); background-size: 200% 100%; animation: shimmer 1.6s linear infinite; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

    /* ── Tabla → tarjetas en mobile (item 7) ──
       Cada <td> lleva un data-label (puesto en renderizarLista()) que se
       muestra como etiqueta vía ::before — la tabla sigue siendo una tabla
       real en el DOM (accesible, sin JS extra para "armar tarjetas"), solo
       cambia cómo se dibuja. */
    @media (max-width: 680px) {
      .tabla-wrap table, .tabla-wrap tbody, .tabla-wrap tr, .tabla-wrap td { display: block; width: 100%; }
      .tabla-wrap thead { display: none; }
      .tabla-wrap tr {
        border: 1px solid var(--gray-300); border-radius: var(--radius-sm);
        padding: 10px 12px; margin-bottom: 10px; white-space: normal;
      }
      .tabla-wrap td {
        border: none; padding: 6px 0; white-space: normal;
        display: flex; justify-content: space-between; align-items: center; gap: 10px;
      }
      .tabla-wrap td::before {
        content: attr(data-label); font-weight: 600; color: var(--gray-500);
        font-size: .7rem; text-transform: uppercase; letter-spacing: .02em; flex-shrink: 0;
      }
      .tabla-wrap td:first-child { font-weight: 700; font-size: .88rem; }
      .tabla-wrap td:first-child::before { content: none; }
      .tabla-wrap td.acciones {
        justify-content: flex-start; flex-wrap: wrap; gap: 8px;
        padding-top: 10px; margin-top: 4px; border-top: 1px solid var(--gray-100);
      }
      .tabla-wrap td.acciones::before { content: none; }

      /* Objetivo táctil de 44×44 como mínimo (item 7) — en desktop los
         botones de fila se quedan compactos, acá se agrandan. */
      .btn, .tab, .nav-item, .hamburguesa { min-height: 44px; }
      .btn-sm, .btn-icono { min-height: 44px; min-width: 44px; padding: 8px 12px; }
    }

    /* ── Badges de estado ── */
    .badge {
      display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 20px;
      font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; font-family: var(--mono);
    }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .badge-indexado { background: var(--green-bg); color: var(--green); }
    .badge-pendiente { background: var(--amber-bg); color: var(--amber); }
    .badge-pendiente::before { animation: pulso 1.1s ease-in-out infinite; }
    @keyframes pulso { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
    .badge-error { background: var(--red-bg); color: var(--red-dark); }

    /* ── Modales ── */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(16,20,28,.5);
      display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 100;
    }
    .modal-box {
      background: var(--white); border-radius: var(--radius); box-shadow: var(--shadow-lg);
      padding: 24px; width: 100%; max-width: 420px;
    }
    .modal-box h3 { font-size: 1rem; margin-bottom: 8px; }
    .modal-box p { font-size: .86rem; color: var(--gray-700); line-height: 1.5; margin-bottom: 16px; }
    .modal-box input[type="file"] { width: 100%; font-size: .85rem; margin-bottom: 16px; }
    .modal-acciones { display: flex; justify-content: flex-end; gap: 8px; }

    /* Preview de documento (item 8): más grande, con un iframe del visor de
       Drive — no hay que descargar nada para ver qué versión está subida. */
    .modal-box-grande { max-width: min(900px, calc(100vw - 32px)); height: min(85vh, 800px); display: flex; flex-direction: column; padding: 0; }
    .modal-header { padding: 14px 16px; border-bottom: 1px solid var(--gray-100); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .modal-header h3 { margin-bottom: 0; font-size: .92rem; }
    .modal-close {
      background: none; border: none; cursor: pointer; font-size: 1.1rem; color: var(--gray-500);
      width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0;
    }
    .modal-close:hover { background: var(--gray-100); }
    .modal-box-grande iframe { flex: 1; width: 100%; border: none; }

    /* ── Toasts ── */
    #toastContainer {
      position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 8px;
      z-index: 200; max-width: min(340px, calc(100vw - 32px));
    }
    .toast {
      background: var(--ink); color: #fff; padding: 12px 16px; border-radius: var(--radius-sm);
      font-size: .84rem; box-shadow: var(--shadow-lg); opacity: 0; transform: translateY(8px);
      transition: opacity .2s, transform .2s;
    }
    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast.toast-exito { background: var(--green); }
    .toast.toast-error { background: var(--red-dark); }

    [hidden] { display: none !important; }

    @media (prefers-reduced-motion: reduce) {
      tr.fila-pendiente, .badge-pendiente::before { animation: none; }
      .toast { transition: none; }
    }
  </style>
</head>
<body>
  <div class="app" id="appAuth">
    <div class="auth-brand"><span class="icono">🛡️</span><span>GarantIA — Panel admin</span></div>

    <div id="vistaLogin" class="auth-shell" hidden>
      <div class="card">
        <h2>Ingresar</h2>
        <p class="card-sub">Ingresá con la contraseña del panel.</p>
        <p class="error-msg" id="loginError"></p>
        <div class="campo">
          <label for="loginPassword">Contraseña</label>
          <input type="password" id="loginPassword" autocomplete="current-password"/>
        </div>
        <button id="btnLogin" class="btn btn-primario">Ingresar</button>
        <div class="auth-links"><button type="button" id="linkOlvide" class="btn-texto">¿Olvidaste tu contraseña?</button></div>
      </div>
    </div>

    <div id="vistaOlvide" class="auth-shell" hidden>
      <div class="card">
        <h2>Recuperar acceso</h2>
        <p class="card-sub">Escribí el email del admin y te mandamos un link para elegir una contraseña nueva.</p>
        <p class="error-msg" id="olvideError"></p>
        <p class="info-msg" id="olvideOk"></p>
        <div class="campo">
          <label for="olvideEmail">Email</label>
          <input type="email" id="olvideEmail" autocomplete="email"/>
        </div>
        <button id="btnOlvide" class="btn btn-primario">Mandar link</button>
        <div class="auth-links"><button type="button" id="linkVolverLogin" class="btn-texto">Volver a ingresar</button></div>
      </div>
    </div>

    <div id="vistaReset" class="auth-shell" hidden>
      <div class="card">
        <h2>Elegir contraseña nueva</h2>
        <p class="card-sub">El link vence a los 15 minutos de haberlo pedido.</p>
        <p class="error-msg" id="resetError"></p>
        <div class="campo">
          <label for="resetPassword1">Contraseña nueva</label>
          <input type="password" id="resetPassword1" autocomplete="new-password"/>
        </div>
        <div class="campo">
          <label for="resetPassword2">Repetir contraseña</label>
          <input type="password" id="resetPassword2" autocomplete="new-password"/>
        </div>
        <button id="btnReset" class="btn btn-primario">Guardar contraseña</button>
      </div>
    </div>
  </div><!-- /app: hasta acá las vistas de auth, centradas y angostas -->

  <!-- El dashboard queda AFUERA de .app a propósito: con sidebar necesita
       todo el ancho de la ventana, no la caja centrada de 960px de las
       pantallas de login. -->
  <div id="vistaDashboard" hidden>
      <div class="sidebar-overlay" id="sidebarOverlay"></div>
      <div class="app-shell">
        <nav class="sidebar" id="sidebar">
          <div class="sidebar-brand"><span class="icono">🛡️</span><span>GarantIA</span></div>
          <button type="button" class="nav-item activo" data-seccion="documentos">📄 Documentos</button>
          <button type="button" class="nav-item" data-seccion="politica">📘 Política de Garantía</button>
          <div class="sidebar-footer">
            <button id="btnLogout" class="btn btn-secundario">Cerrar sesión</button>
          </div>
        </nav>

        <div class="main">
          <div class="topbar">
            <button type="button" class="hamburguesa" id="btnHamburguesa" aria-label="Abrir menú">☰</button>
            <h1 id="topbarTitulo">Documentos</h1>
          </div>

          <section id="seccionDocumentos">
            <div class="card">
              <h2>Subir documento</h2>
              <p class="card-sub">Formatos: PDF, DOCX, XLSX, PPTX.</p>
              <div class="info-alert">
                <span class="icono">💡</span>
                <span>Subí acá tus documentos. Una vez cargados, el sistema los lee e indexa automáticamente: su contenido pasa a formar parte de la base de conocimiento y el asistente puede usarlo para responder consultas.</span>
              </div>
              <form id="formUpload">
                <input type="file" id="inputArchivo" accept=".pdf,.docx,.xlsx,.xls,.pptx"/>
                <button type="submit" id="btnSubir" class="btn btn-primario">Subir e indexar</button>
              </form>
              <div id="estadoJob" class="estado-job"></div>
            </div>

            <div class="card">
              <h2>Documentos indexados</h2>
              <div class="tabla-toolbar">
                <div class="tabs">
                  <button type="button" class="tab activo" data-tab="recientes">Recientes</button>
                  <button type="button" class="tab" data-tab="historial">Historial</button>
                </div>
                <div class="buscador"><input type="text" id="buscador" placeholder="Buscar archivo…"/></div>
              </div>
              <div id="listaArchivos"><p class="vacio">Cargando…</p></div>
            </div>
          </section>

          <section id="seccionPolitica" hidden>
            <div class="card">
              <div class="politica-header">
                <div>
                  <h2>Política de Garantía y Mantenimiento (texto del chat)</h2>
                  <p class="card-sub">El resumen que ve el técnico en el botón 📘 del chat. Es texto aparte del documento indexado — para actualizar lo que usa /chat para responder, subí el archivo nuevo con el mismo nombre en Documentos.</p>
                </div>
                <button id="btnEditarPolitica" class="btn btn-secundario btn-sm">✏️ Editar Política</button>
              </div>

              <div id="politicaPreview" class="politica-preview"><p class="vacio">Cargando…</p></div>

              <div id="politicaEdicion" hidden>
                <p class="card-sub">Formato: Markdown.</p>
                <textarea id="politicaTextarea" rows="14" style="width:100%;font-family:var(--mono);font-size:.8rem;padding:10px;border:1px solid var(--gray-300);border-radius:var(--radius-sm);resize:vertical;"></textarea>
                <div class="politica-acciones">
                  <button id="btnCancelarPolitica" class="btn btn-secundario">Cancelar</button>
                  <button id="btnGuardarPolitica" class="btn btn-primario" disabled>Guardar cambios</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

  <div class="modal-overlay" id="modalConfirm" hidden>
    <div class="modal-box">
      <h3 id="modalConfirmTitulo"></h3>
      <p id="modalConfirmMensaje"></p>
      <div class="modal-acciones">
        <button type="button" id="btnModalCancelar" class="btn btn-secundario">Cancelar</button>
        <button type="button" id="btnModalConfirmar" class="btn btn-destructivo"></button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="modalReemplazo" hidden>
    <div class="modal-box">
      <h3 id="modalReemplazoTitulo">Editar documento</h3>
      <p>Elegí el archivo nuevo para reemplazar el contenido indexado y el documento en Drive — el link que ya está en uso sigue funcionando. El botón se habilita apenas elijas un archivo.</p>
      <input type="file" id="inputReemplazoModal" accept=".pdf,.docx,.xlsx,.xls,.pptx"/>
      <div class="modal-acciones">
        <button type="button" id="btnCancelarReemplazo" class="btn btn-secundario">Cancelar</button>
        <button type="button" id="btnConfirmarReemplazo" class="btn btn-primario" disabled>Guardar cambios</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="modalPreview" hidden>
    <div class="modal-box modal-box-grande">
      <div class="modal-header">
        <h3 id="modalPreviewTitulo">Vista previa</h3>
        <button type="button" class="modal-close" id="btnCerrarPreview" aria-label="Cerrar">✕</button>
      </div>
      <iframe id="iframePreview" title="Vista previa del documento"></iframe>
    </div>
  </div>

  <div id="toastContainer"></div>

  <script type="module">
    // ── pdf.js: build ESM moderno, se carga como módulo dinámico ──
    const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs';

    const appAuth = document.getElementById('appAuth');
    const vistaLogin = document.getElementById('vistaLogin');
    const vistaOlvide = document.getElementById('vistaOlvide');
    const vistaReset = document.getElementById('vistaReset');
    const vistaDashboard = document.getElementById('vistaDashboard');
    const loginError = document.getElementById('loginError');
    const estadoJobEl = document.getElementById('estadoJob');
    const listaArchivosEl = document.getElementById('listaArchivos');
    const buscadorEl = document.getElementById('buscador');
    const toastContainer = document.getElementById('toastContainer');

    let polling = null;
    let archivosActuales = {};
    // Overlay para archivos que sabemos indexados (por el propio job que
    // acabamos de correr) pero que docs:index en KV puede tardar en reflejar
    // — la escritura es KV, no fuerte-consistente al toque. Se descarta solo
    // cuando el fetch de /admin/api/files confirma la entrada real.
    let pendientesOptimistas = {};
    let tabActiva = 'recientes';
    let filtroBusqueda = '';
    let paginaActual = 1;
    const TAMANO_PAGINA = 8;

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

    // ── Toasts ────────────────────────────────────────────────

    function toast(mensaje, tipo) {
      const el = document.createElement('div');
      el.className = 'toast' + (tipo ? ' toast-' + tipo : '');
      el.textContent = mensaje;
      toastContainer.appendChild(el);
      requestAnimationFrame(() => el.classList.add('visible'));
      setTimeout(() => {
        el.classList.remove('visible');
        setTimeout(() => el.remove(), 250);
      }, 3800);
    }

    // ── Modal de confirmación genérico ──────────────────────────

    const modalConfirm = document.getElementById('modalConfirm');
    const modalConfirmTitulo = document.getElementById('modalConfirmTitulo');
    const modalConfirmMensaje = document.getElementById('modalConfirmMensaje');
    const btnModalConfirmar = document.getElementById('btnModalConfirmar');
    const btnModalCancelar = document.getElementById('btnModalCancelar');

    function confirmar({ titulo, mensaje, textoConfirmar }) {
      return new Promise((resolve) => {
        modalConfirmTitulo.textContent = titulo;
        modalConfirmMensaje.textContent = mensaje;
        btnModalConfirmar.textContent = textoConfirmar;
        modalConfirm.hidden = false;

        function limpiar(resultado) {
          modalConfirm.hidden = true;
          btnModalConfirmar.removeEventListener('click', onConfirmar);
          btnModalCancelar.removeEventListener('click', onCancelar);
          resolve(resultado);
        }
        function onConfirmar() { limpiar(true); }
        function onCancelar() { limpiar(false); }
        btnModalConfirmar.addEventListener('click', onConfirmar);
        btnModalCancelar.addEventListener('click', onCancelar);
      });
    }

    // ── Auth: login / logout ────────────────────────────────────

    function ocultarTodasLasVistas() {
      // .app envuelve las 3 vistas de auth y la barra "GarantIA — Panel admin":
      // se oculta entera para que esa barra no quede flotando arriba del dashboard.
      appAuth.hidden = true;
      vistaLogin.hidden = true;
      vistaOlvide.hidden = true;
      vistaReset.hidden = true;
      vistaDashboard.hidden = true;
    }

    function mostrarLogin(mensaje) {
      ocultarTodasLasVistas();
      appAuth.hidden = false;
      vistaLogin.hidden = false;
      loginError.textContent = mensaje || '';
    }

    async function mostrarDashboard() {
      ocultarTodasLasVistas();
      vistaDashboard.hidden = false;
      await cargarArchivos();
      await cargarPolitica();
    }

    // ── Navegación: sidebar (desktop) / menú hamburguesa (mobile) ──────

    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const topbarTitulo = document.getElementById('topbarTitulo');
    const TITULOS_SECCION = { documentos: 'Documentos', politica: 'Política de Garantía' };

    function cerrarSidebar() {
      sidebar.classList.remove('abierto');
      sidebarOverlay.classList.remove('visible');
    }

    document.getElementById('btnHamburguesa').addEventListener('click', () => {
      sidebar.classList.add('abierto');
      sidebarOverlay.classList.add('visible');
    });
    sidebarOverlay.addEventListener('click', cerrarSidebar);

    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const seccion = item.dataset.seccion;
        document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('activo', n === item));
        document.getElementById('seccionDocumentos').hidden = seccion !== 'documentos';
        document.getElementById('seccionPolitica').hidden = seccion !== 'politica';
        topbarTitulo.textContent = TITULOS_SECCION[seccion];
        cerrarSidebar();
      });
    });

    // Mismo sanitizador que usa chatHTML() para las respuestas del chat —
    // duplicado a propósito acá (son dos <script> de páginas distintas, sin
    // forma de compartir código entre plantillas sin build step): el texto
    // de la Política termina viéndolo el mismo modelo de riesgo que
    // cualquier otro contenido que no se escribió a mano en este archivo.
    const ETIQUETAS_PERMITIDAS_POLITICA = new Set([
      'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
      'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'SPAN',
      'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
    ]);

    function limpiarNodoPolitica(nodo) {
      [...nodo.children].forEach((hijo) => {
        limpiarNodoPolitica(hijo);
        if (!ETIQUETAS_PERMITIDAS_POLITICA.has(hijo.tagName)) {
          hijo.replaceWith(...hijo.childNodes);
          return;
        }
        [...hijo.attributes].forEach((attr) => {
          const esHrefValido = hijo.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(attr.value);
          if (!esHrefValido) hijo.removeAttribute(attr.name);
        });
        if (hijo.tagName === 'A' && hijo.getAttribute('href')) {
          hijo.setAttribute('target', '_blank');
          hijo.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }

    function renderizarPoliticaPreview(markdown) {
      const html = marked.parse(String(markdown || ''));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      limpiarNodoPolitica(doc.body);
      politicaPreviewEl.replaceChildren(...doc.body.childNodes);
    }

    // ── Política: modo Vista previa (default) / modo Edición (item 8) ──

    const politicaTextarea = document.getElementById('politicaTextarea');
    const politicaPreviewEl = document.getElementById('politicaPreview');
    const politicaEdicionEl = document.getElementById('politicaEdicion');
    const btnEditarPolitica = document.getElementById('btnEditarPolitica');
    const btnCancelarPolitica = document.getElementById('btnCancelarPolitica');
    const btnGuardarPolitica = document.getElementById('btnGuardarPolitica');
    let politicaOriginal = '';

    function mostrarPoliticaPreview() {
      politicaPreviewEl.hidden = false;
      politicaEdicionEl.hidden = true;
      btnEditarPolitica.hidden = false;
    }

    function mostrarPoliticaEdicion() {
      politicaTextarea.value = politicaOriginal;
      btnGuardarPolitica.disabled = true; // recién se entra a editar, todavía no hay ningún cambio
      politicaPreviewEl.hidden = true;
      politicaEdicionEl.hidden = false;
      btnEditarPolitica.hidden = true;
    }

    async function cargarPolitica() {
      const res = await fetch('/politica');
      const { markdown } = await res.json();
      politicaOriginal = markdown;
      renderizarPoliticaPreview(markdown);
      mostrarPoliticaPreview();
    }

    btnEditarPolitica.addEventListener('click', mostrarPoliticaEdicion);
    btnCancelarPolitica.addEventListener('click', mostrarPoliticaPreview);

    // Item 8: "Guardar cambios" arranca inactivo y solo se habilita cuando
    // el texto realmente difiere de lo que ya está guardado — no alcanza
    // con tocar el campo, tiene que haber un cambio de verdad.
    politicaTextarea.addEventListener('input', () => {
      btnGuardarPolitica.disabled = politicaTextarea.value === politicaOriginal;
    });

    btnGuardarPolitica.addEventListener('click', async () => {
      const markdown = politicaTextarea.value;
      btnGuardarPolitica.disabled = true;
      try {
        const res = await fetch('/admin/api/politica', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown }),
        });
        if (res.status === 401) return mostrarLogin();
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar');
        politicaOriginal = markdown;
        renderizarPoliticaPreview(markdown);
        mostrarPoliticaPreview(); // vuelve solo a modo lectura tras guardar con éxito
        toast('Texto de la Política guardado', 'exito');
      } catch (err) {
        toast(err.message, 'error');
        btnGuardarPolitica.disabled = false; // el guardado falló, sigue habiendo un cambio sin guardar
      }
    });

    async function verificarSesion() {
      // Un link de reseteo con token en la URL manda directo a esa pantalla,
      // sin pasar por el chequeo de sesión — es un flujo aparte del login.
      const params = new URLSearchParams(location.search);
      const tokenReset = params.get('reset');
      if (tokenReset) {
        ocultarTodasLasVistas();
        appAuth.hidden = false;
        vistaReset.hidden = false;
        vistaReset.dataset.token = tokenReset;
        return;
      }

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

    // ── Auth: olvidé mi contraseña ───────────────────────────────

    document.getElementById('linkOlvide').addEventListener('click', () => {
      ocultarTodasLasVistas();
      appAuth.hidden = false;
      vistaOlvide.hidden = false;
      document.getElementById('olvideError').textContent = '';
      document.getElementById('olvideOk').textContent = '';
    });

    document.getElementById('linkVolverLogin').addEventListener('click', () => mostrarLogin());

    document.getElementById('btnOlvide').addEventListener('click', async () => {
      const email = document.getElementById('olvideEmail').value;
      const btn = document.getElementById('btnOlvide');
      btn.disabled = true;
      try {
        const res = await fetch('/admin/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await res.json().catch(() => ({}));
        document.getElementById('olvideError').textContent = res.ok ? '' : data.error || 'No se pudo procesar el pedido';
        document.getElementById('olvideOk').textContent = res.ok ? data.mensaje : '';
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('btnReset').addEventListener('click', async () => {
      const p1 = document.getElementById('resetPassword1').value;
      const p2 = document.getElementById('resetPassword2').value;
      const errorEl = document.getElementById('resetError');
      if (p1 !== p2) {
        errorEl.textContent = 'Las contraseñas no coinciden';
        return;
      }
      const btn = document.getElementById('btnReset');
      btn.disabled = true;
      try {
        const res = await fetch('/admin/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: vistaReset.dataset.token, password: p1 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          errorEl.textContent = data.error || 'No se pudo guardar la contraseña nueva';
          return;
        }
        toast('Contraseña actualizada', 'exito');
        history.replaceState(null, '', location.pathname);
        mostrarLogin();
      } finally {
        btn.disabled = false;
      }
    });

    // ── Archivos: carga, tabs, búsqueda ──────────────────────────

    async function cargarArchivos() {
      const res = await fetch('/admin/api/files');
      if (res.status === 401) return mostrarLogin();
      const { archivos, job } = await res.json();
      archivosActuales = archivos;
      // Ya no hace falta el overlay para lo que el servidor confirmó.
      for (const nombre of Object.keys(pendientesOptimistas)) {
        if (archivos[nombre]) delete pendientesOptimistas[nombre];
      }
      renderizarLista();
      renderizarEstadoJob(job);
      const hayPendientes = Object.values(archivos).some((a) => a.estado === 'pendiente');
      if (job.estado === 'embedding' || hayPendientes) iniciarPolling();
    }

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        tabActiva = tab.dataset.tab;
        paginaActual = 1;
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('activo', t === tab));
        renderizarLista();
      });
    });

    buscadorEl.addEventListener('input', () => {
      filtroBusqueda = buscadorEl.value.trim().toLowerCase();
      paginaActual = 1;
      renderizarLista();
    });

    function badgeDe(estado) {
      if (estado === 'indexado') return '<span class="badge badge-indexado">Indexado</span>';
      if (estado === 'error') return '<span class="badge badge-error">Error</span>';
      return '<span class="badge badge-pendiente">Pendiente</span>';
    }

    function fechaCorta(iso) {
      return iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
    }

    function renderizarLista() {
      const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
      const ahora = Date.now();
      // El overlay optimista tapa el hueco mientras docs:index en KV no
      // propagó todavía; el servidor gana en cuanto confirma la entrada.
      const vista = { ...pendientesOptimistas, ...archivosActuales };

      let nombres = Object.keys(vista).sort((a, b) => {
        const fa = vista[a].subidoEl || '';
        const fb = vista[b].subidoEl || '';
        return fb.localeCompare(fa); // más nuevo primero
      });

      if (tabActiva === 'recientes') {
        nombres = nombres.filter((n) => {
          const t = vista[n].subidoEl ? new Date(vista[n].subidoEl).getTime() : 0;
          return ahora - t <= SIETE_DIAS_MS;
        });
      }
      if (filtroBusqueda) {
        nombres = nombres.filter((n) => n.toLowerCase().includes(filtroBusqueda));
      }

      if (nombres.length === 0) {
        const razon = filtroBusqueda
          ? 'No hay documentos que coincidan con la búsqueda.'
          : tabActiva === 'recientes'
            ? 'No se subió nada en los últimos 7 días — mirá la pestaña Historial.'
            : 'Todavía no se subió ningún documento desde acá.';
        listaArchivosEl.innerHTML = \`<p class="vacio">\${razon}</p>\`;
        return;
      }

      const totalPaginas = Math.max(1, Math.ceil(nombres.length / TAMANO_PAGINA));
      if (paginaActual > totalPaginas) paginaActual = totalPaginas;
      const inicio = (paginaActual - 1) * TAMANO_PAGINA;
      const nombresPagina = nombres.slice(inicio, inicio + TAMANO_PAGINA);

      const filas = nombresPagina
        .map((nombre) => {
          const info = vista[nombre];
          const esPendiente = info.estado === 'pendiente';
          const puedePreview = Boolean(info.driveFileId);
          return \`<tr\${esPendiente ? ' class="fila-pendiente"' : ''}>
            <td data-label="Archivo">\${escaparHTML(nombre)}</td>
            <td class="fecha" data-label="Subido">\${fechaCorta(info.subidoEl)}</td>
            <td class="fecha" data-label="Indexado">\${fechaCorta(info.indexadoEl)}</td>
            <td data-label="Estado">\${badgeDe(info.estado)}</td>
            <td class="chunks" data-label="Fragmentos">\${info.chunks ?? '—'}</td>
            <td class="acciones" data-label="Acciones">
              <button class="btn btn-secundario btn-sm btn-icono previsualizar" data-nombre="\${escaparHTML(nombre)}" \${puedePreview ? '' : 'disabled'} title="Ver documento" aria-label="Ver documento">👁️<span class="texto-accion">Previsualizar</span></button>
              <button class="btn btn-secundario btn-sm btn-icono editar" data-nombre="\${escaparHTML(nombre)}" title="Editar documento" aria-label="Editar documento">✏️<span class="texto-accion">Editar</span></button>
              <button class="btn btn-destructivo btn-sm btn-icono borrar" data-nombre="\${escaparHTML(nombre)}" title="Eliminar" aria-label="Eliminar documento">🗑️<span class="texto-accion">Eliminar</span></button>
            </td>
          </tr>\`;
        })
        .join('');

      const paginadorHTML =
        totalPaginas > 1
          ? \`<div class="paginador">
              <button type="button" class="btn btn-secundario btn-sm" id="btnPaginaAnterior" \${paginaActual === 1 ? 'disabled' : ''}>← Anterior</button>
              <span class="paginador-info">Página \${paginaActual} de \${totalPaginas}</span>
              <button type="button" class="btn btn-secundario btn-sm" id="btnPaginaSiguiente" \${paginaActual === totalPaginas ? 'disabled' : ''}>Siguiente →</button>
            </div>\`
          : '';

      listaArchivosEl.innerHTML = \`<div class="tabla-wrap"><table>
        <thead><tr><th>Archivo</th><th>Subido</th><th>Indexado</th><th>Estado</th><th>Fragmentos</th><th>Acciones</th></tr></thead>
        <tbody>\${filas}</tbody>
      </table></div>\${paginadorHTML}\`;

      listaArchivosEl.querySelectorAll('button.borrar').forEach((btn) => {
        btn.addEventListener('click', () => eliminarArchivo(btn.dataset.nombre));
      });
      listaArchivosEl.querySelectorAll('button.editar').forEach((btn) => {
        btn.addEventListener('click', () => abrirModalReemplazo(btn.dataset.nombre));
      });
      listaArchivosEl.querySelectorAll('button.previsualizar').forEach((btn) => {
        btn.addEventListener('click', () => abrirPreview(btn.dataset.nombre));
      });
      const btnPaginaAnterior = document.getElementById('btnPaginaAnterior');
      const btnPaginaSiguiente = document.getElementById('btnPaginaSiguiente');
      if (btnPaginaAnterior) {
        btnPaginaAnterior.addEventListener('click', () => {
          paginaActual -= 1;
          renderizarLista();
        });
      }
      if (btnPaginaSiguiente) {
        btnPaginaSiguiente.addEventListener('click', () => {
          paginaActual += 1;
          renderizarLista();
        });
      }
    }

    function escaparHTML(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function eliminarArchivo(nombre) {
      const ok = await confirmar({
        titulo: 'Eliminar documento',
        mensaje: \`¿Estás seguro de que deseas eliminar este documento? "\${nombre}". Esta acción no se puede deshacer y el documento dejará de estar disponible en las consultas.\`,
        textoConfirmar: 'Eliminar',
      });
      if (!ok) return;

      const res = await fetch(\`/admin/api/files/\${encodeURIComponent(nombre)}/delete\`, { method: 'POST' });
      if (res.status === 401) return mostrarLogin();
      if (!res.ok) {
        toast('No se pudo eliminar el documento', 'error');
        return;
      }
      toast('Documento eliminado correctamente', 'exito');
      delete pendientesOptimistas[nombre];
      await cargarArchivos();
    }

    // ── Reemplazo vía modal (item 4) ─────────────────────────────

    const modalReemplazo = document.getElementById('modalReemplazo');
    const modalReemplazoTitulo = document.getElementById('modalReemplazoTitulo');
    const inputReemplazoModal = document.getElementById('inputReemplazoModal');

    const btnConfirmarReemplazo = document.getElementById('btnConfirmarReemplazo');

    function abrirModalReemplazo(nombre) {
      modalReemplazoTitulo.textContent = \`Editar "\${nombre}"\`;
      inputReemplazoModal.value = '';
      // Arranca inactivo (item 8): recién se habilita cuando el input
      // confirma que hay un archivo elegido, no antes.
      btnConfirmarReemplazo.disabled = true;
      modalReemplazo.dataset.nombre = nombre;
      modalReemplazo.hidden = false;
    }

    inputReemplazoModal.addEventListener('change', () => {
      btnConfirmarReemplazo.disabled = inputReemplazoModal.files.length === 0;
    });

    document.getElementById('btnCancelarReemplazo').addEventListener('click', () => {
      modalReemplazo.hidden = true;
    });

    btnConfirmarReemplazo.addEventListener('click', async () => {
      const file = inputReemplazoModal.files[0];
      if (!file) return; // el botón está inactivo hasta acá, esto es solo defensivo
      const nombre = modalReemplazo.dataset.nombre;
      modalReemplazo.hidden = true;
      await subirArchivo(file, nombre);
    });

    // ── Preview de documento (item 8) ────────────────────────────

    const modalPreview = document.getElementById('modalPreview');
    const modalPreviewTitulo = document.getElementById('modalPreviewTitulo');
    const iframePreview = document.getElementById('iframePreview');

    function abrirPreview(nombre) {
      const info = { ...pendientesOptimistas, ...archivosActuales }[nombre];
      if (!info?.driveFileId) {
        toast('Este documento no tiene una vista previa disponible', 'error');
        return;
      }
      modalPreviewTitulo.textContent = nombre;
      iframePreview.src = \`https://drive.google.com/file/d/\${info.driveFileId}/preview\`;
      modalPreview.hidden = false;
    }

    function cerrarPreview() {
      modalPreview.hidden = true;
      iframePreview.src = ''; // corta la carga/reproducción al cerrar
    }

    document.getElementById('btnCerrarPreview').addEventListener('click', cerrarPreview);
    modalPreview.addEventListener('click', (e) => {
      if (e.target === modalPreview) cerrarPreview();
    });

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

        toast('Archivo subido con éxito, indexando…', 'exito');
        renderizarEstadoJob({ estado: 'embedding', nextIndex: 0, total: data.total, fileName: nombreAReemplazar || file.name });
        await cargarArchivos();
        iniciarPolling();
      } catch (err) {
        renderizarEstadoJob({ estado: 'error', error: err.message });
        toast(err.message, 'error');
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
          if (job.estado === 'done') {
            toast('Indexación completada', 'exito');
            pendientesOptimistas[job.fileName] = {
              estado: 'indexado',
              chunks: job.total,
              driveFileId: job.driveFileId,
              driveUrl: job.driveUrl,
              subidoEl: new Date().toISOString(),
              indexadoEl: new Date().toISOString(),
            };
            renderizarLista();
            await cargarArchivos();
          } else if (job.estado === 'error') {
            await cargarArchivos();
          }
        }
      }, 2500);
    }

    function renderizarEstadoJob(job) {
      estadoJobEl.className = 'estado-job visible';
      if (job.estado === 'parseando') {
        estadoJobEl.textContent = job.mensaje;
      } else if (job.estado === 'embedding') {
        estadoJobEl.textContent = \`Indexando "\${job.fileName || ''}": \${job.nextIndex ?? 0} / \${job.total ?? '?'} fragmentos…\`;
      } else if (job.estado === 'done') {
        estadoJobEl.className = 'estado-job visible done';
        estadoJobEl.textContent = \`Listo: "\${job.fileName}" indexado (\${job.total} fragmentos).\`;
      } else if (job.estado === 'error') {
        estadoJobEl.className = 'estado-job visible error';
        estadoJobEl.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = 'Error: ' + (job.error || 'desconocido');
        estadoJobEl.appendChild(p);
        const btn = document.createElement('button');
        btn.className = 'btn btn-primario btn-sm';
        btn.textContent = 'Reintentar';
        btn.addEventListener('click', reintentarJob);
        estadoJobEl.appendChild(btn);
      } else {
        estadoJobEl.className = 'estado-job';
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
