const SYSTEM_PROMPT = `Sos GarantIA, asistente de garantías Toyota del taller Derka y Vargas, Sáenz Peña.

## CUÁNDO REPREGUNTAR Y CUÁNDO NO
Distinguí dos tipos de consulta:

1. El técnico trae un vehículo con una falla: quiere saber cómo resolverla o si está cubierta.
   Ahí necesitás modelo + síntoma + kilometraje. Si te falta alguno, preguntá UNA sola cosa por vez:
   - Si no sabés el modelo → preguntá el modelo y año
   - Si no sabés el problema → preguntá el síntoma
   - Si no sabés el kilometraje → preguntá kilometraje o fecha de entrega
   Solo cuando tenés los tres, respondé con los detalles.

2. La pregunta es general: qué cubre o qué excluye un programa, qué dice un boletín, cómo es un
   procedimiento, qué plazos rigen, qué componentes entran en una categoría.
   Ahí NO pidas modelo, síntoma ni kilometraje: no hay un vehículo puntual del que hablar.
   Respondé directamente con el contexto.

Ante la duda, si el técnico no mencionó ninguna falla concreta, es del tipo 2.

Mencionar un modelo junto a una pieza puntual NO es una falla por sí solo: solo es tipo 1 si el
técnico describe además una anomalía (algo roto, que no anda, un síntoma). "La traba del capot,
¿entra en Toyota10 para la Corolla?" no tiene falla — es tipo 2, aunque nombre modelo y pieza.

## Al responder
- Usá solo la información del contexto provisto
- No inventes coberturas ni procedimientos
- Cuando des información de garantía, terminá con una línea así, con el nombre real del archivo y sin corchetes:
  📄 Basado en: NOMBRE DEL ARCHIVO.pdf
- Si estás repreguntando en vez de responder, NO cites ningún archivo
- Si no hay información: "No encontré datos sobre esto. Consultá con el responsable de garantías.", y si el turno te pasa documentos parecidos, listalos abajo con el nombre de archivo tal cual`;

// Mapa nombre de archivo -> URL de Drive, que publica src/drive_upload.js.
const KV_KEY_DOCS = 'docs:urls';

// Versión de la lógica de respuesta, que va en la clave del caché.
//
// SUBIRLA al tocar el SYSTEM_PROMPT, el prompt de reformulación, el pipeline de
// búsqueda o MAX_TOKENS_RESPUESTA. Sin esto, las respuestas generadas con la
// lógica anterior —incluidas las que quedaron truncadas— se siguen
// sirviendo hasta que vence el TTL de una hora, y el deploy parece no haber
// tenido efecto: pasó con "decime todo lo que entra en toyota 10", que después
// de arreglar la repregunta seguía devolviendo el pedido de modelo cacheado.
// Las claves viejas no se borran, vencen solas.
const VERSION_CACHE = 4;

// Convierte en link cada nombre de archivo que el modelo haya citado. Se hace en
// una sola pasada con una alternativa por documento: reemplazar de a uno haría
// que un nombre corto matcheara adentro del markdown recién insertado por otro
// más largo. Van ordenados de mayor a menor por el mismo motivo.
function linkificarFuentes(reply, mapa) {
	const nombres = Object.keys(mapa)
		.filter((n) => reply.includes(n))
		.sort((a, b) => b.length - a.length);

	if (nombres.length === 0) return reply;

	const patron = nombres.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	return reply.replace(new RegExp(patron, 'g'), (nombre) => `[${nombre}](${mapa[nombre]})`);
}

async function conLinksDeDrive(env, reply) {
	try {
		const mapa = await env.garantia_cache.get(KV_KEY_DOCS, 'json');
		return mapa ? linkificarFuentes(reply, mapa) : reply;
	} catch (err) {
		// Si el mapa todavía no se publicó o está roto, la respuesta sirve igual
		// con el nombre del archivo en texto plano.
		console.error('No se pudo aplicar el mapa de Drive:', err);
		return reply;
	}
}

// Umbral de relevancia de un fragmento. Medido contra el índice real con
// consultas acumuladas (las que arma construirConsulta): las que tienen respuesta
// en la base puntúan 0.727–0.800 y las que no, 0.694–0.740. Los rangos se
// solapan, así que NO hay un corte que separe limpio: cualquier valor ahí adentro
// pierde respuestas buenas o deja entrar ruido.
//
// Se elige errar por incluir. Un falso positivo lo descarta el modelo, que igual
// tiene que decidir si el contexto responde la pregunta; un falso negativo, en
// cambio, pierde en silencio un documento que sí servía. Por eso el corte va
// apenas debajo del acierto más flojo medido (0.727) y no en el medio.
// Atado a este modelo de embeddings y a este corpus: si cambia alguno, remedir.
const UMBRAL_RELEVANCIA = 0.72;

// Cuántos documentos se ofrecen como "lo más parecido" cuando no hay nada por
// encima del umbral.
const MAX_SUGERENCIAS = 3;

// Cuántos turnos del usuario se arrastran a la búsqueda. El prompt repregunta
// hasta tres veces (modelo, síntoma, kilometraje), así que con tres alcanza para
// reconstruir el caso sin arrastrar una consulta anterior ya cerrada.
const TURNOS_DE_CONTEXTO = 3;

// La búsqueda va sobre el caso acumulado, no sobre el último mensaje. Como el
// prompt obliga a pedir modelo, síntoma y kilometraje de a uno, al tercer turno
// el último mensaje suele ser "130.000 km, entrega 15/01/2020" — que como
// consulta semántica no recupera nada útil y descarta lo que el técnico ya dijo.
function construirConsulta(message, history) {
	const previos = history
		.filter((m) => m.role === 'user')
		.slice(-TURNOS_DE_CONTEXTO)
		.map((m) => m.content);
	return [...previos, message].join('. ');
}

function fuentesUnicas(matches, limite) {
	return [...new Set(matches.map((m) => m.metadata?.source).filter(Boolean))].slice(0, limite);
}

// Tope de fragmentos que van al prompt cuando las dos búsquedas aportan. Con 8
// el contexto sigue entrando cómodo en la ventana y no diluye la pregunta.
const MAX_FRAGMENTOS = 8;

// Reescribe el caso del técnico al vocabulario de los documentos.
//
// Hace falta porque el técnico escribe síntomas y los documentos de cobertura
// hablan de componentes. Medido: "pérdida de líquido en amortiguadores" no
// recupera la exclusión de Toyota 10 ni en el top-30, mientras que "los
// amortiguadores entran en garantía" la trae primera. Son la misma pregunta.
//
// La regla de no incluir modelo ni kilometraje también salió de la medición:
// agregando "srx 2020" a una consulta que funcionaba, los boletines de la barra
// deportiva de la SRX tapaban el documento general de términos y condiciones.
//
// Las reglas van sin ejemplo concreto de pieza a propósito. Una versión anterior
// decía 'nombrá el componente como un manual: "amortiguadores de suspensión"' y
// el modelo lo copiaba: un caso de vibración al frenar se reescribía como
// amortiguadores. La regla de no cambiar de tema usa frenos justamente porque no
// es ninguno de los componentes que aparecen seguido en las consultas reales.
const PROMPT_REFORMULACION = `Convertís el caso de un técnico de taller en una consulta de búsqueda sobre documentos de garantía Toyota.

Reglas:
- Nombrá la pieza o el sistema del que habla el caso con el término que usaría un manual, no con la palabra coloquial del taller
- No cambies de tema: si el caso habla de frenos, la consulta habla de frenos
- NO describas el síntoma ni la falla. Nada de ruidos, pérdidas, fugas, vibraciones ni roturas
- NO incluyas modelo, versión, año ni kilometraje
- Si la consulta no menciona ninguna pieza concreta, NO inventes una: devolvé solo las palabras de cobertura
- Cerrá siempre con: garantía cobertura exclusiones componentes de mantenimiento y desgaste
- Respondé UNA sola línea, sin comillas ni explicación`;

async function reformularConsulta(env, consulta) {
	try {
		const texto = await generateReply(env, PROMPT_REFORMULACION, [], consulta);
		const linea = (texto || '').trim().split('\n')[0].trim().slice(0, 200);
		return linea.length >= 3 ? linea : null;
	} catch (err) {
		// La reformulación es una mejora, no un requisito: si falla, queda la
		// búsqueda con la consulta cruda, que es lo que había antes.
		console.error('No se pudo reformular la consulta:', err);
		return null;
	}
}

async function buscarFragmentos(env, consulta) {
	const embedding = await embedText(env, consulta, 'RETRIEVAL_QUERY');
	const res = await env.VECTORIZE.query(embedding, { topK: 5, returnMetadata: 'all' });
	return res.matches || [];
}

// Une los resultados de las dos búsquedas quedándose con el mejor score de cada
// fragmento. El umbral se aplica a cada búsqueda por separado y recién después se
// unen: los scores salen de vectores de consulta distintos, así que compararlos
// entre sí no significa nada, pero cada uno contra su propio umbral sí.
function unirMatches(...listas) {
	const porId = new Map();
	for (const m of listas.flat()) {
		const previo = porId.get(m.id);
		if (!previo || m.score > previo.score) porId.set(m.id, m);
	}
	return [...porId.values()].sort((a, b) => b.score - a.score);
}

// Aviso que reemplaza una cita inventada. Se prefiere una respuesta marcada como
// sin respaldo antes que una que aparenta tenerlo.
const AVISO_SIN_RESPALDO = '⚠️ Esta respuesta no sale de un documento de la base. Verificá con el responsable de garantías antes de aplicarla.';

const CITA_RE = /^[ \t]*📄[ \t]*Basado en:[ \t]*(.+?)[ \t]*$/gm;

// El modelo a veces cierra con "📄 Basado en: <archivo>" nombrando un documento
// que nunca estuvo en el contexto: responde de conocimiento general y le pega
// encima el nombre de un archivo que sí existe en el corpus. Verificado en
// producción — una consulta por ruido en la distribución recuperó solo ABI-515 y
// la respuesta citó Toyota 10 - T&C.pdf.
//
// Como la cita después se convierte en link a Drive, el técnico termina abriendo
// un PDF que no dice lo que el bot afirmó, y eso es peor que no responder. Acá se
// reescribe la línea dejando únicamente los archivos que sí se le pasaron.
// Falla cerrado: un bug acá pierde una cita válida, no habilita una inventada.
function validarCitas(reply, permitidos) {
	return reply.replace(CITA_RE, (_linea, citado) => {
		const validos = [...permitidos].filter((nombre) => citado.includes(nombre));
		return validos.length > 0 ? `📄 Basado en: ${validos.join(', ')}` : AVISO_SIN_RESPALDO;
	});
}

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_DIMENSIONS = 768;
const GEMINI_CHAT_MODEL = 'gemini-3.5-flash-lite';

// Con 512 las respuestas largas se cortaban a la mitad y, peor, se perdía la
// línea de la fuente, que va al final. Se veía en "listame todo lo que cubre el
// programa Toyota 10": terminaba en "**Sistema de frenos" y sin cita.
//
// Medido sobre esa consulta, que es de las más largas que puede haber porque
// enumera todos los sistemas cubiertos: 512 devuelve finishReason MAX_TOKENS,
// y la respuesta completa usa entre 930 y 1131 tokens según la corrida. 1024
// entra justo, así que el tope va en 1536 para tener margen. Como se factura por
// token generado y no por el tope, subirlo no cuesta nada si la respuesta es corta.
const MAX_TOKENS_RESPUESTA = 1536;

async function embedText(env, text, taskType) {
	const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:embedContent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': env.GOOGLE_API_KEY,
		},
		body: JSON.stringify({
			content: { parts: [{ text }] },
			taskType,
			outputDimensionality: GEMINI_EMBED_DIMENSIONS,
		}),
	});
	const data = await res.json();
	if (!data.embedding?.values) {
		throw new Error('Error generando embedding: ' + JSON.stringify(data));
	}
	return data.embedding.values;
}

function toGeminiRole(role) {
	return role === 'assistant' ? 'model' : 'user';
}

async function generateReply(env, systemPrompt, history, userPrompt) {
	const contents = [
		...history.map((m) => ({ role: toGeminiRole(m.role), parts: [{ text: m.content }] })),
		{ role: 'user', parts: [{ text: userPrompt }] },
	];

	const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_CHAT_MODEL}:generateContent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': env.GOOGLE_API_KEY,
		},
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: systemPrompt }] },
			contents,
			generationConfig: { temperature: 0.2, maxOutputTokens: MAX_TOKENS_RESPUESTA },
		}),
	});
	const data = await res.json();
	return data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

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
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					// La UI entera —HTML, CSS y JS— viaja en esta respuesta y cambia en
					// cada deploy. Sin esta cabecera el navegador le aplica caché
					// heurístico y sigue mostrando la versión anterior: un arreglo de
					// estilo puede quedar invisible aunque el Worker ya esté actualizado.
					'Cache-Control': 'no-cache',
					...CORS_HEADERS,
				},
			});
		}

		return new Response('Not found', { status: 404 });
	},
};

export async function handleChat(request, env) {
	try {
		const { message, history = [] } = await request.json();
		const isFirstMessage = history.length === 0;

		if (!message || message.trim() === '') {
			return Response.json({ error: 'Mensaje vacío' }, { status: 400, headers: CORS_HEADERS });
		}

		// 1. Revisar caché KV
		const cacheKey = `chat:v${VERSION_CACHE}:${message.trim().toLowerCase().slice(0, 100)}`;

		if (isFirstMessage) {
			const cached = await env.garantia_cache.get(cacheKey);
			if (cached) return Response.json({ reply: await conLinksDeDrive(env, cached), cached: true }, { headers: CORS_HEADERS });
		}

		// 2. Búsqueda doble: la consulta cruda y otra reescrita al vocabulario de
		// los documentos. Las dos redacciones recuperan cosas distintas y las dos
		// hacen falta — la cruda encuentra los boletines técnicos, que describen
		// síntomas, y la reformulada encuentra los términos y condiciones, que
		// enumeran componentes. Buscar con las dos hace que reformular solo pueda
		// sumar: si el modelo devuelve cualquier cosa, la búsqueda cruda sigue ahí.
		const consulta = construirConsulta(message, history);
		const reformulada = await reformularConsulta(env, consulta);

		const [crudos, reformulados] = await Promise.all([
			buscarFragmentos(env, consulta),
			reformulada ? buscarFragmentos(env, reformulada) : Promise.resolve([]),
		]);

		const encontrados = unirMatches(crudos, reformulados);
		const matches = unirMatches(
			crudos.filter((m) => m.score > UMBRAL_RELEVANCIA),
			reformulados.filter((m) => m.score > UMBRAL_RELEVANCIA)
		).slice(0, MAX_FRAGMENTOS);

		console.log(
			'Búsqueda:',
			JSON.stringify({
				reformulada,
				cruda: crudos.map((m) => ({ score: m.score, source: m.metadata?.source })),
				reescrita: reformulados.map((m) => ({ score: m.score, source: m.metadata?.source })),
			})
		);

		// 3. Armar contexto — solo con los fragmentos por encima del umbral
		const context =
			matches.length > 0 ? matches.map((m) => `[${m.metadata?.source || 'Documento'}]\n${m.metadata?.text || ''}`).join('\n\n') : '';

		// 4. Armar el prompt del turno.
		//
		// Los documentos más cercanos se ofrecen haya o no contexto por encima del
		// umbral. Como los rangos de score se solapan, quien termina decidiendo si
		// hay respuesta es el modelo, no el filtro: si se listaran solo en la rama
		// "sin resultados", el técnico se quedaría sin referencia justo en el caso
		// más común, que es un score alto sobre un documento que no viene al caso.
		// Los nombres salen linkeados solos: conLinksDeDrive matchea por archivo.
		const cercanos = fuentesUnicas(encontrados, MAX_SUGERENCIAS);
		const siNoHay =
			cercanos.length > 0
				? 'Si el contexto no responde la pregunta, escribí "No encontré datos sobre esto. Consultá con el responsable de garantías.",' +
					' después una línea "Lo más parecido que hay en la base:" y debajo estos nombres tal cual, uno por línea con guión:\n' +
					cercanos.map((n) => `- ${n}`).join('\n')
				: 'Si el contexto no responde la pregunta, escribí: "No encontré datos sobre esto. Consultá con el responsable de garantías."';

		const userPrompt = context
			? `Contexto de documentos:\n${context}\n\n---\nPregunta: ${message}\n\n` +
				`Si el técnico trae una falla concreta y te falta modelo, síntoma o kilometraje, hacé UNA sola pregunta antes de responder. ` +
				`Si la pregunta es general, respondé directamente con el contexto.\n${siNoHay}`
			: `Pregunta: ${message}\n\nNo hay ningún documento en la base que responda esto.\n\n` +
				`Si el técnico trae una falla concreta y todavía te falta el modelo, el síntoma o el kilometraje, ` +
				`hacé UNA sola pregunta y terminá ahí.\n${siNoHay}`;

		// 5. Llamar a Gemini y descartar las citas que no correspondan a un
		// documento realmente entregado en este turno.
		const generado = (await generateReply(env, SYSTEM_PROMPT, history, userPrompt)) || 'No pude generar una respuesta. Intentá de nuevo.';
		const permitidos = new Set([...matches.map((m) => m.metadata?.source).filter(Boolean), ...cercanos]);
		const reply = validarCitas(generado, permitidos);

		// 6. Guardar en caché por 1 hora — sin los links, así una republicación del
		// mapa de Drive se refleja en las respuestas ya cacheadas.
		if (isFirstMessage) {
			await env.garantia_cache.put(cacheKey, reply, { expirationTtl: 3600 });
		}

		return Response.json({ reply: await conLinksDeDrive(env, reply), cached: false }, { headers: CORS_HEADERS });
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
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
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
      padding: 11px 14px; border-radius: 14px;
      font-size: .85rem; line-height: 1.55;
      white-space: pre-wrap; word-break: break-word;
    }
    /* El texto del bot entra como markdown ya parseado a nodos, así que los saltos
       de línea que quedan ENTRE los <p> y los <li> son separadores del HTML, no
       parte del mensaje. Con pre-wrap se renderizaban como líneas en blanco y las
       respuestas largas quedaban con el doble de aire del que corresponde.
       El de usuario sí lo conserva: ahí el salto lo escribió la persona. */
    .bubble.bot {
      background: var(--white); color: var(--black);
      border: 1px solid var(--gray-border);
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 2px rgba(0,0,0,.05);
      white-space: normal;
    }
    .bubble.user {
      background: var(--red); color: #fff;
      border-bottom-right-radius: 4px;
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

    /* ── Markdown de la respuesta ──
       Un solo ritmo vertical: 8px entre bloques, 3px entre items de lista. Los
       reset de primer y último hijo evitan el aire de más contra los bordes de
       la burbuja, que es lo que hace que un mensaje corto parezca flotar. */
    .bubble.bot > :first-child { margin-top: 0; }
    .bubble.bot > :last-child { margin-bottom: 0; }

    .bubble.bot p { margin: 0 0 8px; }

    .bubble.bot ul, .bubble.bot ol { margin: 0 0 8px; padding-left: 18px; }
    .bubble.bot li { margin-bottom: 3px; }
    .bubble.bot li:last-child { margin-bottom: 0; }
    /* marked envuelve cada item en <p> cuando el markdown trae líneas en blanco */
    .bubble.bot li p { margin: 0; }
    .bubble.bot li::marker { color: var(--red); }
    .bubble.bot li > ul, .bubble.bot li > ol { margin: 3px 0 0; }

    .bubble.bot strong { font-weight: 700; }

    /* Fuentes citadas: llevan al documento en Drive */
    .bubble.bot a {
      color: var(--red);
      text-decoration: underline;
      text-underline-offset: 2px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .bubble.bot a:hover { color: var(--red-dark); }

    /* La línea de la fuente cierra el mensaje: va separada por un filete y en
       cuerpo menor, para que se lea como pie y no como un párrafo más. */
    .bubble.bot .fuente {
      margin-top: 10px; padding-top: 8px;
      border-top: 1px solid var(--gray-border);
      font-size: .75rem; color: var(--gray-text);
    }

    .bubble.bot h1, .bubble.bot h2, .bubble.bot h3, .bubble.bot h4 {
      font-size: .82rem;
      font-weight: 700;
      margin: 14px 0 6px;
      color: var(--black);
    }

    .bubble.bot hr {
      border: 0; border-top: 1px solid var(--gray-border);
      margin: 12px 0;
    }

    .bubble.bot code {
    background: #f0f0f0;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: .78rem;
    font-family: monospace;
    }

    /* Línea del "Basado en:" con color diferenciado */
    .bubble.bot p:last-child:not(:first-child) {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--gray-border);
    font-size: .75rem;
    color: var(--gray-text);
    }

    /* Separador horizontal */
    .bubble.bot hr {
    border: none;
    border-top: 1px solid var(--gray-border);
    margin: 8px 0;
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
        <div class="cards-grid role-grid">
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
    let conversationHistory = [];

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
      conversationHistory = [];
      inChat = false;
      homeScreen.style.display = 'block';
      backBtn.classList.remove('visible');
      /* Limpia mensajes del DOM */
      chat.querySelectorAll('.msg-row, #typing-row').forEach(el => el.remove());
      input.value = '';
      input.style.height = 'auto';
      chat.scrollTop = 0;
    }

    // Lo que devuelve el modelo es texto arbitrario, y marked deja pasar el HTML
    // crudo que venga adentro. Metido directo en innerHTML, un <img onerror=...>
    // se ejecuta. Por eso el markdown se renderiza en un documento inerte, se
    // filtra contra una lista blanca y recién ahí se inserta.
    const ETIQUETAS_PERMITIDAS = new Set([
      'P','BR','HR','STRONG','B','EM','I','DEL','CODE','PRE','BLOCKQUOTE',
      'UL','OL','LI','H1','H2','H3','H4','H5','H6','A','SPAN',
      'TABLE','THEAD','TBODY','TR','TH','TD',
    ]);

    function limpiarNodo(nodo) {
      [...nodo.children].forEach(hijo => {
        // Primero los descendientes: así, si hay que desarmar este elemento, lo
        // que sube al padre ya viene limpio.
        limpiarNodo(hijo);

        if (!ETIQUETAS_PERMITIDAS.has(hijo.tagName)) {
          // Se conserva el texto y se tira la etiqueta.
          hijo.replaceWith(...hijo.childNodes);
          return;
        }

        // Sin excepciones para on*, style, srcdoc y demás: el único atributo que
        // sobrevive es el href de un link http(s), lo que descarta javascript:.
        [...hijo.attributes].forEach(attr => {
          const esHrefValido = hijo.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(attr.value);
          if (!esHrefValido) hijo.removeAttribute(attr.name);
        });

        // Los links de las fuentes van a Drive: se abren aparte para no perder
        // la conversación.
        if (hijo.tagName === 'A' && hijo.getAttribute('href')) {
          hijo.setAttribute('target', '_blank');
          hijo.setAttribute('rel', 'noopener noreferrer');
        }
      });
    }

    // Contenedores cuyos hijos son bloques: el salto de línea que marked deja
    // entre ellos es formato del HTML, nunca contenido. Se excluyen a propósito
    // P, LI, SPAN y demás, donde un espacio suelto SÍ separa palabras — sacarlo
    // pegaría "…cubre" con un <strong> que viene después.
    const CONTENEDORES_DE_BLOQUES = new Set(['BODY', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

    function quitarEspaciosEstructurales(nodo) {
      if (CONTENEDORES_DE_BLOQUES.has(nodo.tagName)) {
        [...nodo.childNodes]
          .filter((h) => h.nodeType === Node.TEXT_NODE && !h.textContent.trim())
          .forEach((h) => h.remove());
      }
      [...nodo.children].forEach(quitarEspaciosEstructurales);
    }

    function renderMarkdownSeguro(text) {
      const html = marked.parse(String(text || ''));
      // DOMParser no ejecuta scripts ni dispara handlers: el documento queda
      // inerte hasta que uno decide adoptarlo.
      const doc = new DOMParser().parseFromString(html, 'text/html');
      limpiarNodo(doc.body);

      quitarEspaciosEstructurales(doc.body);

      // La clase va DESPUÉS de limpiarNodo, que borra todos los atributos.
      const ultimo = doc.body.lastElementChild;
      if (ultimo && ultimo.textContent.trimStart().startsWith('📄')) {
        ultimo.classList.add('fuente');
      }

      return [...doc.body.childNodes];
    }

    function addMsg(text, role, cached = false) {
        if (role === 'user') conversationHistory.push({ role: 'user', content: text });
        if (role === 'bot')  conversationHistory.push({ role: 'assistant', content: text });

        const row = document.createElement('div');
        row.className = 'msg-row ' + role;

        const av = document.createElement('div');
        av.className = 'avatar ' + (role === 'user' ? 'user-av' : '');
        av.textContent = role === 'user' ? 'TÚ' : 'G';

        const meta = document.createElement('div');
        meta.className = 'msg-meta';

        const bubble = document.createElement('div');
        bubble.className = 'bubble ' + role + (cached ? ' cached' : '');

        if (role === 'bot') {
            try {
            // Configurar marked para mejor compatibilidad
            marked.setOptions({
                breaks: true,    // saltos de línea simples → <br>
                gfm: true,       // GitHub Flavored Markdown
            });
            bubble.replaceChildren(...renderMarkdownSeguro(text));
            } catch (e) {
            // Fallback: mostrar como texto plano si marked falla
            bubble.textContent = text;
            }
        } else {
            bubble.textContent = text;
        }

        const time = document.createElement('div');
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

      const historySnapshot = conversationHistory.slice(-10);

      input.value = '';
      input.style.height = 'auto';
      btn.disabled = true;
      addMsg(msg, 'user');
      showTyping();

      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: msg,
            history: historySnapshot,
          }),
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
