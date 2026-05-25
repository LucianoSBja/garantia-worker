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

		// 3. Buscar en Vectorize — score bajo para no filtrar de más
		const vectorResults = await env.VECTORIZE.query(embedding, {
			topK: 5,
			returnMetadata: 'all',
		});

		// Debug: loguear scores para diagnosticar
		console.log(
			'Vectorize matches:',
			JSON.stringify((vectorResults.matches || []).map((m) => ({ score: m.score, source: m.metadata?.source }))),
		);

		// 4. Armar contexto — sin filtro de score mínimo
		let context = '';
		if (vectorResults.matches && vectorResults.matches.length > 0) {
			context = vectorResults.matches.map((m) => `[${m.metadata?.source || 'Documento'}]\n${m.metadata?.text || ''}`).join('\n\n');
		}

		// 5. Armar prompt para Llama
		const userPrompt = context
			? `[CONTEXTO DE DOCUMENTOS]\n${context}\n[FIN DEL CONTEXTO]\n\nPregunta: ${message}`
			: `Pregunta: ${message}\n\nNota: No se encontraron documentos relevantes en la base de conocimiento.`;

		// 6. Llamar a Llama 3 via Workers AI
		const llmResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: 1024,
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
      --bubble-user: #EB0A1E;
      --bubble-bot: #ffffff;
      --shadow: 0 2px 8px rgba(0,0,0,0.08);
      --radius: 12px;

      /* Tokens responsive */
      --header-height: 64px;
      --chat-px: 20px;
      --footer-px: 16px;
      --bubble-max: min(72%, 520px);
      --font-bubble: 0.88rem;
      --font-suggestion: 0.78rem;
    }

    html, body {
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--gray-bg);
      color: var(--black);
    }

    /* ── Layout principal ── */
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
      padding: 0 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      height: var(--header-height);
      flex-shrink: 0;
      /* Safe area para notch/Dynamic Island */
      padding-left: max(20px, env(safe-area-inset-left));
      padding-right: max(16px, env(safe-area-inset-right));
    }

    .header-logo {
      height: 26px;
      width: auto;
      filter: brightness(0) invert(1);
      flex-shrink: 0;
    }

    .header-divider {
      width: 1px;
      height: 26px;
      background: rgba(255,255,255,0.3);
      flex-shrink: 0;
    }

    .header-info {
      flex: 1;
      min-width: 0; /* permite truncar */
    }

    .header-info h1 {
      font-size: clamp(0.78rem, 2.5vw, 0.95rem);
      font-weight: 700;
      color: var(--white);
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-info p {
      font-size: clamp(0.65rem, 2vw, 0.72rem);
      color: rgba(255,255,255,0.8);
      margin-top: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-badge {
      flex-shrink: 0;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.25);
      color: white;
      font-size: 0.68rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 20px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    /* ── Barra de estado ── */
    .status-bar {
      background: #f9f9f9;
      border-bottom: 1px solid var(--gray-border);
      padding: 7px 20px;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
      color: var(--gray-text);
      flex-shrink: 0;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      flex-shrink: 0;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Área de chat ── */
    .chat-area {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 20px var(--chat-px);
      display: flex;
      flex-direction: column;
      gap: 14px;
      scroll-behavior: smooth;
    }

    /* ── Bienvenida ── */
    .welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 16px 0 6px;
      gap: 8px;
    }

    .welcome-icon {
      width: 48px;
      height: 48px;
      background: var(--red);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.3rem;
      flex-shrink: 0;
    }

    .welcome h2 {
      font-size: clamp(0.92rem, 3vw, 1rem);
      font-weight: 700;
      color: var(--black);
    }

    .welcome p {
      font-size: clamp(0.78rem, 2.5vw, 0.82rem);
      color: var(--gray-text);
      max-width: 300px;
      line-height: 1.5;
    }

    /* ── Sugerencias ── */
    .suggestions {
      display: grid;
      /* 2 columnas en mobile, 4 en wide */
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      padding: 0;
    }

    .suggestion-btn {
      background: var(--white);
      border: 1px solid var(--gray-border);
      color: var(--black);
      font-size: var(--font-suggestion);
      padding: 10px 12px;
      border-radius: 10px;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      text-align: left;
      line-height: 1.35;
      min-height: 44px;
      display: flex;
      align-items: center;
      gap: 6px;
      touch-action: manipulation; /* evita zoom en doble-tap iOS */
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    .suggestion-btn:hover,
    .suggestion-btn:focus-visible {
      border-color: var(--red);
      color: var(--red);
      background: #fff5f5;
      outline: none;
    }

    .suggestion-btn:active {
      background: #ffe5e5;
    }

    /* ── Mensajes ── */
    .msg-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .msg-row.user {
      flex-direction: row-reverse;
    }

    .avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--red);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-weight: 700;
      color: white;
      flex-shrink: 0;
      /* No mostrar en pantallas muy chicas */
    }

    .avatar.user-av {
      background: var(--black);
    }

    .bubble {
      max-width: var(--bubble-max);
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: var(--font-bubble);
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .bubble.bot {
      background: var(--bubble-bot);
      color: var(--black);
      border: 1px solid var(--gray-border);
      border-bottom-left-radius: 3px;
      box-shadow: var(--shadow);
    }

    .bubble.user {
      background: var(--bubble-user);
      color: white;
      border-bottom-right-radius: 3px;
    }

    .bubble.cached::after {
      content: " ⚡";
      font-size: 0.72rem;
      opacity: 0.6;
    }

    .msg-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .msg-time {
      font-size: 0.63rem;
      color: var(--gray-text);
      margin-top: 3px;
      padding: 0 3px;
    }

    .msg-row.user .msg-time {
      text-align: right;
    }

    /* ── Typing ── */
    .typing-bubble {
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 13px 16px;
      background: var(--white);
      border: 1px solid var(--gray-border);
      border-radius: var(--radius);
      border-bottom-left-radius: 3px;
      box-shadow: var(--shadow);
      width: fit-content;
    }

    .typing-bubble span {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #bbb;
      animation: bounce 1.2s infinite;
    }

    .typing-bubble span:nth-child(2) { animation-delay: 0.15s; }
    .typing-bubble span:nth-child(3) { animation-delay: 0.30s; }

    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-5px); }
    }

    /* ── Footer / Input ── */
    .footer {
      border-top: 1px solid var(--gray-border);
      background: var(--white);
      padding: 10px var(--footer-px) max(14px, env(safe-area-inset-bottom));
      flex-shrink: 0;
    }

    .input-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .input-wrap {
      flex: 1;
      position: relative;
      min-width: 0;
    }

    textarea {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid var(--gray-border);
      border-radius: 10px;
      font-size: max(1rem, 16px); /* NUNCA < 16px → evita zoom en iOS Safari */
      font-family: inherit;
      resize: none;
      outline: none;
      max-height: 120px;
      line-height: 1.5;
      transition: border-color 0.15s;
      color: var(--black);
      background: var(--white);
      -webkit-appearance: none;
      touch-action: manipulation; /* evita delay de 300ms en iOS */
    }

    textarea:focus {
      border-color: var(--red);
    }

    textarea::placeholder {
      color: #aaa;
    }

    .send-btn {
      /* Área de toque mínima 44×44 */
      width: 44px;
      height: 44px;
      background: var(--red);
      border: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, transform 0.1s;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .send-btn:hover { background: var(--red-dark); }
    .send-btn:active { transform: scale(0.93); }
    .send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .send-btn svg {
      width: 18px;
      height: 18px;
      fill: white;
    }

    .footer-note {
      font-size: 0.67rem;
      color: #bbb;
      text-align: center;
      margin-top: 7px;
      line-height: 1.4;
    }

    /* ════════════════════════════════════
       BREAKPOINTS
    ════════════════════════════════════ */

    /* ── Pantallas muy pequeñas (< 360px) ── */
    @media (max-width: 359px) {
      :root {
        --chat-px: 10px;
        --footer-px: 10px;
        --bubble-max: 88%;
        --font-bubble: 0.82rem;
        --font-suggestion: 0.72rem;
      }

      .header {
        height: 52px;
        gap: 8px;
        padding-left: 10px;
        padding-right: 10px;
      }

      .header-logo { height: 18px; }
      .header-badge { display: none; }
      .header-divider { display: none; }
      .header-info h1 { font-size: 0.82rem; }
      .header-info p { display: none; }

      .avatar { display: none; }

      .suggestions {
        grid-template-columns: 1fr;
      }
    }

    /* ── Mobile estándar (360–599px) ── */
    @media (min-width: 360px) and (max-width: 599px) {
      :root {
        --chat-px: 12px;
        --footer-px: 12px;
        --bubble-max: 82%;
        --font-bubble: 0.85rem;
        --font-suggestion: 0.76rem;
      }

      .header {
        height: 56px;
        padding-left: 14px;
        padding-right: 14px;
      }

      .header-logo { height: 22px; }
      .header-badge { display: none; }

      .suggestions {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    /* ── Tablet (600–859px) ── */
    @media (min-width: 600px) and (max-width: 859px) {
      :root {
        --chat-px: 20px;
        --bubble-max: 75%;
      }

      .suggestions {
        grid-template-columns: repeat(2, 1fr);
        max-width: 480px;
        margin: 0 auto;
      }

      .header-badge { display: flex; }
    }

    /* ── Desktop (≥ 860px) ── */
    @media (min-width: 860px) {
      body { background: var(--white); }
      .app { max-width: 100%; box-shadow: none; }

      .suggestions {
        grid-template-columns: repeat(4, 1fr);
        max-width: 640px;
        margin: 0 auto;
      }
    }

    /* ── Landscape mobile (altura reducida) ── */
    @media (max-height: 500px) and (orientation: landscape) {
      :root { --header-height: 48px; }

      .welcome { padding: 8px 0 4px; gap: 5px; }
      .welcome-icon { width: 36px; height: 36px; font-size: 1rem; }
      .welcome h2 { font-size: 0.88rem; }
      .welcome p { display: none; }

      .chat-area { padding-top: 10px; gap: 10px; }

      .suggestions {
        grid-template-columns: repeat(4, 1fr);
      }
    }
  </style>
</head>
<body>
  <div class="app">

    <!-- Header -->
    <header class="header">
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

    <!-- Status -->
    <div class="status-bar">
      <div class="status-dot"></div>
      <span>Sistema activo · Base de conocimiento actualizada</span>
    </div>

    <!-- Chat -->
    <div class="chat-area" id="chat">

      <div class="welcome">
        <div class="welcome-icon">🔧</div>
        <h2>¡Hola! Soy GarantIA</h2>
        <p>Consultame sobre coberturas, plazos y procedimientos de garantía Toyota. Respondo con información de los documentos oficiales.</p>
      </div>

      <div class="suggestions">
        <button class="suggestion-btn" onclick="suggest(this)">🔋 Garantía de baterías</button>
        <button class="suggestion-btn" onclick="suggest(this)">🚗 Hilux — garantía motor</button>
        <button class="suggestion-btn" onclick="suggest(this)">📋 Boletín ABI-517 Land Cruiser</button>
        <button class="suggestion-btn" onclick="suggest(this)">🔊 Ruido portón Hiace</button>
      </div>

    </div>

    <!-- Footer -->
    <footer class="footer">
      <div class="input-row">
        <div class="input-wrap">
          <textarea
            id="input"
            rows="1"
            placeholder="Consultá sobre garantías Toyota..."
            oninput="autoResize(this)"
            onkeydown="handleKey(event)"
          ></textarea>
        </div>
        <button class="send-btn" id="btn" onclick="sendMessage()" aria-label="Enviar">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/>
          </svg>
        </button>
      </div>
      <p class="footer-note">GarantIA responde con documentos oficiales. Verificá siempre con el responsable ante dudas.</p>
    </footer>

  </div>

  <script>
    const chat = document.getElementById("chat");
    const input = document.getElementById("input");
    const btn = document.getElementById("btn");

    function autoResize(el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }

    function handleKey(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    function suggest(el) {
      // Limpia el emoji del inicio y envía directamente
      input.value = el.textContent.trim().replace(/^[\p{Emoji}\s]+/u, "").trim();
      autoResize(input);
      sendMessage();
    }

    function now() {
      return new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    }

    function addMsg(text, role, cached = false) {
      const row = document.createElement("div");
      row.className = "msg-row " + role;

      const av = document.createElement("div");
      av.className = "avatar " + (role === "user" ? "user-av" : "");
      av.textContent = role === "user" ? "TU" : "G";

      const meta = document.createElement("div");
      meta.className = "msg-meta";

      const bubble = document.createElement("div");
      bubble.className = "bubble " + role + (cached ? " cached" : "");
      bubble.textContent = text;

      const time = document.createElement("div");
      time.className = "msg-time";
      time.textContent = now();

      meta.appendChild(bubble);
      meta.appendChild(time);
      row.appendChild(av);
      row.appendChild(meta);
      chat.appendChild(row);
      chat.scrollTop = chat.scrollHeight;
    }

    function showTyping() {
      const row = document.createElement("div");
      row.className = "msg-row bot";
      row.id = "typing-row";

      const av = document.createElement("div");
      av.className = "avatar";
      av.textContent = "G";

      const bubble = document.createElement("div");
      bubble.className = "typing-bubble";
      bubble.innerHTML = "<span></span><span></span><span></span>";

      row.appendChild(av);
      row.appendChild(bubble);
      chat.appendChild(row);
      chat.scrollTop = chat.scrollHeight;
    }

    function removeTyping() {
      const t = document.getElementById("typing-row");
      if (t) t.remove();
    }

    async function sendMessage() {
      const msg = input.value.trim();
      if (!msg || btn.disabled) return;

      const suggestions = document.querySelector(".suggestions");
      if (suggestions) suggestions.style.display = "none";
      const welcome = document.querySelector(".welcome");
      if (welcome) welcome.style.display = "none";

      input.value = "";
      input.style.height = "auto";
      btn.disabled = true;
      addMsg(msg, "user");
      showTyping();

      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        removeTyping();
        addMsg(data.reply || data.error, "bot", data.cached);
      } catch {
        removeTyping();
        addMsg("Error de conexión. Intentá de nuevo.", "bot");
      } finally {
        btn.disabled = false;
        input.focus();
      }
    }
  </script>
</body>
</html>`;
}
