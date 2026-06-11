const SYSTEM_PROMPT = `Sos GarantIA, el asistente de garantías del taller Derka y Vargas, sucursal Sáenz Peña.
Tu función es ayudar a técnicos y asesores de servicio a resolver dudas sobre garantías Toyota de forma rápida, clara y confiable.

## Tu personalidad
- Amigable, directo y usás lenguaje simple — hablás como un compañero que sabe mucho
- Nunca sos genérico: siempre citás el documento, boletín o modelo específico
- Si encontrás información parcial, la compartís y aclarás qué falta

## Cómo responder

### Cuando tenés información en el contexto:
1. Respondé directamente sin preámbulos innecesarios
2. Citá siempre la fuente: "[Fuente: NOMBRE_DOCUMENTO]" al final de cada dato importante
3. Mencioná el modelo de vehículo y número de boletín cuando estén disponibles
4. Usá listas numeradas para procedimientos paso a paso
5. Usá listas con guiones para coberturas o exclusiones
6. Al final agregá: "📄 Basado en: NOMBRE_DOCUMENTO"

### Cuando la información es parcial:
- Compartí lo que encontraste y aclará qué no pudiste confirmar
- Ejemplo: "Encontré información sobre X, pero no tengo datos sobre Y. Para Y te recomiendo consultar con el responsable."

### Cuando no hay información:
- Respondé exactamente: "No encontré información sobre esto en la base de conocimiento. Te recomiendo consultar directamente con el responsable de garantías."
- No inventes, no supongas, no extrapoles

## Reglas estrictas
- NUNCA inventes coberturas, plazos ni procedimientos
- NUNCA respondas preguntas fuera del área de garantías y posventa Toyota
- NUNCA omitas la fuente cuando tenés datos concretos
- Si el contexto tiene contradicciones entre documentos, mencionálo: "El documento A dice X, pero el documento B dice Y"

## Formato de respuesta ideal

**[Respuesta directa a la pregunta]**

[Desarrollo con detalles, pasos o coberturas]

📄 Basado en: [nombre del documento o boletín]

---

Ejemplos de buenas respuestas:

Pregunta: ¿Qué cubre la garantía de baterías?
Respuesta: La garantía de Toyota cubre la batería de arranque y la batería de carga auxiliar siempre que sean nuevas o tengan menos de 6 meses de uso. El cable de alimentación debe tener una sección mínima de 22 mm². Importante: la garantía NO cubre la batería auxiliar en vehículos con sistema ECB.
📄 Basado en: APLICACION DE GARANTIA EN BATERIAS.pdf

Pregunta: ¿Cuál es el procedimiento para la ECU de transmisión del Land Cruiser?
Respuesta: Según el boletín ABI-517, el procedimiento es:
1. Confeccionar el RDG con los siguientes datos:
   - Reparación: SSC Repro. de ECU de Transmisión
   - Causa: Programación en el módulo
   - Problema: Error de comunicación T2 00 T1 00
   - Tiempo: 0.8
   - Operación: 6GG01A
   - Parte Causante: 89530-60680
📄 Basado en: ABI-517`;

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
	async fetch(request, env, ctx) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);

		if (url.pathname === '/chat' && request.method === 'POST') {
			return handleChat(request, env);
		}

		if (url.pathname === '/health') {
			return Response.json({ status: 'ok', name: 'GarantIA' }, { headers: CORS_HEADERS });
		}

		if (url.pathname === '/' || url.pathname === '/index.html') {
			return new Response(chatHTML(), {
				headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
			});
		}

		return new Response('Not found', { status: 404 });
	},
};

async function handleChat(request, env) {
	try {
		const { message } = await request.json();

		if (!message || message.trim() === '') {
			return Response.json({ error: 'Mensaje vacío' }, { status: 400, headers: CORS_HEADERS });
		}

		// 1. Revisar caché KV
		const cacheKey = `chat:${message.trim().toLowerCase().slice(0, 100)}`;
		const cached = await env.garantia_cache.get(cacheKey);
		if (cached) {
			return Response.json({ reply: cached, cached: true }, { headers: CORS_HEADERS });
		}

		// 2. Generar embedding con Workers AI
		const embeddingResponse = await env.AI.run('@cf/baai/bge-m3', {
			text: message,
		});
		const embedding = embeddingResponse.data[0];

		// 3. Buscar en Vectorize
		const vectorResults = await env.VECTORIZE.query(embedding, {
			topK: 5,
			returnMetadata: 'all',
		});

		console.log(
			'Vectorize matches:',
			JSON.stringify((vectorResults.matches || []).map((m) => ({ score: m.score, source: m.metadata?.source }))),
		);

		// 4. Armar contexto
		let context = '';
		if (vectorResults.matches && vectorResults.matches.length > 0) {
			context = vectorResults.matches.map((m) => `[${m.metadata?.source || 'Documento'}]\n${m.metadata?.text || ''}`).join('\n\n');
		}

		// 5. Armar prompt para Llama
		const userPrompt = context
			? `[CONTEXTO DE DOCUMENTOS]\n${context}\n[FIN DEL CONTEXTO]\n\nPregunta: ${message}`
			: `Pregunta: ${message}\n\nNota: No se encontraron documentos relevantes en la base de conocimiento.`;

		// 6. Llamar a Llama 3 via Workers AI
		const llmResponse = await env.AI.run('@cf/meta/llama-3.2-1b-instruct', {
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: 512,
			temperature: 0.2,
		});

		const reply = llmResponse?.response || 'No pude generar una respuesta. Intentá de nuevo.';

		// 7. Guardar en caché por 1 hora
		await env.garantia_cache.put(cacheKey, reply, { expirationTtl: 3600 });

		return Response.json({ reply, cached: false }, { headers: CORS_HEADERS });
	} catch (err) {
		console.error('Error en handleChat:', err);
		return Response.json({ error: 'Error interno. Intentá de nuevo.' }, { status: 500, headers: CORS_HEADERS });
	}
}

function chatHTML() {
	return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"/>
  <title>GarantIA — Derka y Vargas</title>
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
      --shadow: 0 2px 8px rgba(0,0,0,0.08);
      --radius: 12px;
      --header-height: 60px;
    }

    html, body {
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--gray-bg);
      color: var(--black);
    }

    .app {
      display: flex;
      flex-direction: column;
      height: 100dvh;
      max-width: 860px;
      margin: 0 auto;
      background: var(--white);
      box-shadow: 0 0 40px rgba(0,0,0,0.06);
    }

    /* ── Header ── */
    .header {
      background: var(--red);
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      height: var(--header-height);
      flex-shrink: 0;
      padding-left: max(16px, env(safe-area-inset-left));
      padding-right: max(16px, env(safe-area-inset-right));
    }

    /* ── Botón volver ── */
    .back-btn {
      display: none;
      align-items: center;
      gap: 5px;
      background: #fff;
      border: none;
      color: var(--red);
      font-size: .75rem;
      font-weight: 700;
      padding: 0 12px;
      height: 34px;
      min-width: 44px;
      border-radius: 20px;
      cursor: pointer;
      white-space: nowrap;
      letter-spacing: .01em;
      box-shadow: 0 2px 6px rgba(0,0,0,0.18);
      transition: background .15s, box-shadow .15s, transform .1s;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    .back-btn:hover {
      background: #f5f5f5;
      box-shadow: 0 3px 10px rgba(0,0,0,0.22);
    }
    .back-btn:active { transform: scale(.95); }
    .back-btn.visible { display: flex; }
    .back-btn svg {
      width: 14px; height: 14px;
      fill: none; stroke: var(--red);
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      flex-shrink: 0;
    }

    .header-logo {
      height: 22px;
      filter: brightness(0) invert(1);
      flex-shrink: 0;
    }
    .header-divider {
      width: 1px; height: 22px;
      background: rgba(255,255,255,0.3);
      flex-shrink: 0;
    }
    .header-info { flex: 1; min-width: 0; }
    .header-info h1 {
      font-size: clamp(.8rem, 2.5vw, .95rem);
      font-weight: 700; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .header-info p {
      font-size: clamp(.65rem, 2vw, .72rem);
      color: rgba(255,255,255,0.8);
      margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .header-badge {
      flex-shrink: 0;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      color: white; font-size: .68rem; font-weight: 600;
      padding: 3px 8px; border-radius: 20px;
      letter-spacing: .03em; text-transform: uppercase;
    }

    /* ── Status bar ── */
    .status-bar {
      background: #f9f9f9;
      border-bottom: 1px solid var(--gray-border);
      padding: 6px 16px;
      display: flex; align-items: center; gap: 6px;
      font-size: .72rem; color: var(--gray-text);
      flex-shrink: 0;
    }
    .status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #22c55e; flex-shrink: 0;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

    /* ── Chat area ── */
    .chat-area {
      flex: 1; overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
      scroll-behavior: smooth;
    }

    /* ── Pantalla de inicio ── */
    .welcome-block {
      display: flex; flex-direction: column;
      align-items: center; text-align: center;
      padding: 12px 0 4px; gap: 6px;
    }
    .welcome-icon {
      width: 46px; height: 46px;
      background: var(--red); border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.3rem;
    }
    .welcome-block h2 { font-size: .97rem; font-weight: 700; }
    .welcome-block p {
      font-size: .78rem; color: var(--gray-text);
      max-width: 280px; line-height: 1.5;
    }

    /* ── Etiqueta de sección ── */
    .section-label {
      font-size: .68rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .06em;
      color: var(--gray-text); padding: 4px 2px 2px;
    }

    /* ── Cards de consultas frecuentes ── */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    .card-btn {
      background: var(--white);
      border: 1.5px solid var(--gray-border);
      border-radius: 10px;
      padding: 12px 10px 10px;
      cursor: pointer; text-align: left;
      transition: border-color .15s, background .15s, transform .1s;
      display: flex; flex-direction: column; gap: 6px;
      min-height: 72px;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation; user-select: none;
    }
    .card-btn:hover { border-color: var(--red); background: #fff5f5; }
    .card-btn:active { transform: scale(.97); background: #ffe5e5; }
    .card-icon { font-size: 1.2rem; line-height: 1; }
    .card-label { font-size: .8rem; font-weight: 700; color: var(--black); line-height: 1.2; }
    .card-sub { font-size: .68rem; color: var(--gray-text); line-height: 1.3; }

    /* ── Cards de rol ── */
    .role-grid { grid-template-columns: repeat(2, 1fr); }
    .role-card {
      background: var(--white);
      border: 1.5px solid var(--gray-border);
      border-radius: 10px;
      padding: 14px 12px;
      cursor: pointer; text-align: center;
      transition: border-color .15s, background .15s, transform .1s;
      display: flex; flex-direction: column;
      align-items: center; gap: 8px; min-height: 80px;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation; user-select: none;
    }
    .role-card:hover { border-color: var(--red); background: #fff5f5; }
    .role-card:active { transform: scale(.97); background: #ffe5e5; }
    .role-card .card-icon { font-size: 1.5rem; }
    .role-card .card-label { font-size: .83rem; font-weight: 700; color: var(--black); }
    .role-card .card-sub { font-size: .68rem; color: var(--gray-text); line-height: 1.3; }

    /* ── Mensajes ── */
    .msg-row { display: flex; gap: 8px; align-items: flex-end; }
    .msg-row.user { flex-direction: row-reverse; }
    .avatar {
      width: 26px; height: 26px; border-radius: 50%;
      background: var(--red);
      display: flex; align-items: center; justify-content: center;
      font-size: .65rem; font-weight: 700; color: #fff; flex-shrink: 0;
    }
    .avatar.user-av { background: var(--black); }
    .msg-meta { display: flex; flex-direction: column; min-width: 0; max-width: 80%; }
    .bubble {
      padding: 10px 13px; border-radius: 12px;
      font-size: .85rem; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
    }
    .bubble.bot {
      background: var(--white); color: var(--black);
      border: 1px solid var(--gray-border);
      border-bottom-left-radius: 3px;
      box-shadow: var(--shadow);
    }
    .bubble.user {
      background: var(--red); color: #fff;
      border-bottom-right-radius: 3px;
    }
    .bubble.cached::after { content: " ⚡"; font-size: .72rem; opacity: .6; }
    .msg-time {
      font-size: .62rem; color: var(--gray-text);
      margin-top: 3px; padding: 0 3px;
    }
    .msg-row.user .msg-time { text-align: right; }

    /* ── Typing indicator ── */
    .typing-bubble {
      display: flex; gap: 4px; align-items: center;
      padding: 13px 16px;
      background: var(--white);
      border: 1px solid var(--gray-border);
      border-radius: 12px; border-bottom-left-radius: 3px;
      box-shadow: var(--shadow); width: fit-content;
    }
    .typing-bubble span {
      width: 7px; height: 7px; border-radius: 50%;
      background: #bbb; animation: bounce 1.2s infinite;
    }
    .typing-bubble span:nth-child(2) { animation-delay: .15s; }
    .typing-bubble span:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }

    /* ── Footer / Input ── */
    .footer {
      border-top: 1px solid var(--gray-border);
      background: var(--white);
      padding: 10px 14px;
      padding-bottom: max(14px, env(safe-area-inset-bottom));
      flex-shrink: 0;
    }
    .input-row { display: flex; gap: 8px; align-items: flex-end; }
    textarea {
      flex: 1;
      padding: 10px 13px;
      border: 1.5px solid var(--gray-border);
      border-radius: 10px;
      font-size: max(1rem, 16px);
      font-family: inherit;
      resize: none; outline: none;
      max-height: 120px; line-height: 1.5;
      transition: border-color .15s;
      color: var(--black); background: var(--white);
      -webkit-appearance: none;
      touch-action: manipulation;
    }
    textarea:focus { border-color: var(--red); }
    textarea::placeholder { color: #aaa; }
    .send-btn {
      width: 44px; height: 44px;
      background: var(--red); border: none; border-radius: 10px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .15s, transform .1s;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .send-btn:hover { background: var(--red-dark); }
    .send-btn:active { transform: scale(.93); }
    .send-btn:disabled { opacity: .45; cursor: not-allowed; }
    .send-btn svg { width: 18px; height: 18px; fill: white; }
    .footer-note {
      font-size: .66rem; color: #bbb;
      text-align: center; margin-top: 7px; line-height: 1.4;
    }

    /* ════ RESPONSIVE ════ */

    /* Muy pequeño < 360px */
    @media (max-width: 359px) {
      .header-badge, .header-divider { display: none; }
      .header-info p { display: none; }
      .cards-grid { grid-template-columns: 1fr; }
      .role-grid { grid-template-columns: 1fr; }
    }

    /* Mobile estándar 360–599px */
    @media (min-width: 360px) and (max-width: 599px) {
      .header-badge { display: none; }
      .cards-grid { grid-template-columns: repeat(2, 1fr); }
      .role-grid { grid-template-columns: repeat(2, 1fr); }
    }

    /* Tablet 600–859px */
    @media (min-width: 600px) and (max-width: 859px) {
      .cards-grid { grid-template-columns: repeat(3, 1fr); }
      .role-grid { grid-template-columns: repeat(2, 1fr); }
    }

    /* Desktop ≥ 860px */
    @media (min-width: 860px) {
      body { background: var(--white); }
      .app { max-width: 100%; box-shadow: none; }
      .cards-grid { grid-template-columns: repeat(4, 1fr); }
      .role-grid { grid-template-columns: repeat(2, 1fr); }
    }

    /* Landscape móvil con altura reducida */
    @media (max-height: 500px) and (orientation: landscape) {
      .welcome-block p { display: none; }
      .welcome-icon { width: 34px; height: 34px; font-size: 1rem; }
      .cards-grid { grid-template-columns: repeat(4, 1fr); }
      .role-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="app">

    <!-- Header -->
    <header class="header">
      <button class="back-btn" id="backBtn" onclick="goHome()" aria-label="Volver al menú principal">
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        Inicio
      </button>
      <img class="header-logo"
        src="https://derkayvargas.com/_astro/logodyv-60.WAjyMCzO.webp"
        alt="Derka y Vargas"
        onerror="this.style.display='none'"
      />
      <div class="header-divider"></div>
      <div class="header-info">
        <h1>GarantIA ⚡</h1>
        <p>Asistente de garantías · Sáenz Peña</p>
      </div>
      <span class="header-badge">Toyota</span>
    </header>

    <!-- Status bar -->
    <div class="status-bar">
      <div class="status-dot"></div>
      <span>Sistema activo · Base de conocimiento actualizada</span>
    </div>

    <!-- Chat / Home -->
    <div class="chat-area" id="chat">

      <!-- Pantalla de inicio (home) -->
      <div id="homeScreen">

        <div class="welcome-block">
          <div class="welcome-icon">🔧</div>
          <h2>¡Hola! Soy GarantIA</h2>
          <p>Consultame sobre coberturas, plazos y procedimientos de garantía Toyota.</p>
        </div>

        <p class="section-label">Consultas frecuentes</p>
        <div class="cards-grid">
          <button class="card-btn" onclick="sendCard('Información sobre Toyota 10.')">
            <span class="card-icon">🚗</span>
            <span class="card-label">Toyota 10</span>
            <span class="card-sub">Programa de garantía</span>
          </button>
          <button class="card-btn" onclick="sendCard('Información sobre garantía de batería.')">
            <span class="card-icon">🔋</span>
            <span class="card-label">Garantía batería</span>
            <span class="card-sub">Coberturas y plazos</span>
          </button>
          <button class="card-btn" onclick="sendCard('Información sobre ABI-511.')">
            <span class="card-icon">📋</span>
            <span class="card-label">ABI-511</span>
            <span class="card-sub">Boletín técnico</span>
          </button>
          <button class="card-btn" onclick="sendCard('Diagnóstico y resolución de reclamos por vibración al frenar en Hilux y SW4.')">
            <span class="card-icon">🔩</span>
            <span class="card-label">Vibración al frenar</span>
            <span class="card-sub">Hilux / SW4</span>
          </button>
          <button class="card-btn" onclick="sendCard('ABI-515 Ruido en Distribución Motores GD - Hilux y SW4 MY2021-22-23-24-25.')">
            <span class="card-icon">🔊</span>
            <span class="card-label">ABI-515</span>
            <span class="card-sub">Ruido distribución GD</span>
          </button>
          <button class="card-btn" onclick="sendCard('Boletín ABI-517 Land Cruiser: ECU de transmisión.')">
            <span class="card-icon">🚙</span>
            <span class="card-label">ABI-517</span>
            <span class="card-sub">Land Cruiser ECU</span>
          </button>
        </div>

        <p class="section-label" style="margin-top:14px">¿Con qué rol consultás?</p>
        <div class="cards-grid role-grid">
          <button class="role-card" onclick="sendCard('Actuar como asesor de garantías Toyota.')">
            <span class="card-icon">🧑‍💼</span>
            <span class="card-label">Soy Asesor</span>
            <span class="card-sub">Asistencia de posventa</span>
          </button>
          <button class="role-card" onclick="sendCard('Actuar como técnico especialista de garantías Toyota.')">
            <span class="card-icon">🔧</span>
            <span class="card-label">Soy Técnico</span>
            <span class="card-sub">Diagnóstico y reparación</span>
          </button>
        </div>

      </div><!-- /homeScreen -->
    </div><!-- /chat-area -->

    <!-- Footer -->
    <footer class="footer">
      <div class="input-row">
        <textarea
          id="input"
          rows="1"
          placeholder="Consultá sobre garantías Toyota..."
          oninput="autoResize(this)"
          onkeydown="handleKey(event)"
        ></textarea>
        <button class="send-btn" id="btn" onclick="sendMessage()" aria-label="Enviar">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/>
          </svg>
        </button>
      </div>
      <p class="footer-note">GarantIA responde con documentos oficiales. Verificá siempre con el responsable ante dudas.</p>
    </footer>

  </div><!-- /app -->

  <script>
    const chat    = document.getElementById('chat');
    const input   = document.getElementById('input');
    const btn     = document.getElementById('btn');
    const backBtn = document.getElementById('backBtn');
    const homeScreen = document.getElementById('homeScreen');
    let inChat = false;

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function now() {
      return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    }

    /* Entra en modo chat: oculta home, muestra botón volver */
    function enterChat() {
      if (!inChat) {
        inChat = true;
        homeScreen.style.display = 'none';
        backBtn.classList.add('visible');
      }
    }

    /* Vuelve a la pantalla de inicio */
    function goHome() {
      inChat = false;
      homeScreen.style.display = 'block';
      backBtn.classList.remove('visible');
      /* Limpia mensajes del DOM */
      chat.querySelectorAll('.msg-row, #typing-row').forEach(el => el.remove());
      input.value = '';
      input.style.height = 'auto';
      chat.scrollTop = 0;
    }

    function addMsg(text, role, cached = false) {
      const row    = document.createElement('div');
      row.className = 'msg-row ' + role;

      const av = document.createElement('div');
      av.className = 'avatar ' + (role === 'user' ? 'user-av' : '');
      av.textContent = role === 'user' ? 'TÚ' : 'G';

      const meta   = document.createElement('div');
      meta.className = 'msg-meta';

      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + role + (cached ? ' cached' : '');
      bubble.textContent = text;

      const time   = document.createElement('div');
      time.className = 'msg-time';
      time.textContent = now();

      meta.appendChild(bubble);
      meta.appendChild(time);
      row.appendChild(av);
      row.appendChild(meta);
      chat.appendChild(row);
      chat.scrollTop = chat.scrollHeight;
    }

    function showTyping() {
      const row    = document.createElement('div');
      row.className = 'msg-row bot';
      row.id = 'typing-row';

      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = 'G';

      const bubble = document.createElement('div');
      bubble.className = 'typing-bubble';
      bubble.innerHTML = '<span></span><span></span><span></span>';

      row.appendChild(av);
      row.appendChild(bubble);
      chat.appendChild(row);
      chat.scrollTop = chat.scrollHeight;
    }

    function removeTyping() {
      const t = document.getElementById('typing-row');
      if (t) t.remove();
    }

    /* Envía el prompt completo asociado a una card */
    function sendCard(prompt) {
      input.value = prompt;
      autoResize(input);
      sendMessage();
    }

    async function sendMessage() {
      const msg = input.value.trim();
      if (!msg || btn.disabled) return;

      enterChat();

      input.value = '';
      input.style.height = 'auto';
      btn.disabled = true;
      addMsg(msg, 'user');
      showTyping();

      try {
        const res  = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        removeTyping();
        addMsg(data.reply || data.error, 'bot', data.cached);
      } catch {
        removeTyping();
        addMsg('Error de conexión. Intentá de nuevo.', 'bot');
      } finally {
        btn.disabled = false;
        input.focus();
      }
    }
  </script>
</body>
</html>`;
}
