import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleChat } from '../../src/index.js';

function mockFetch({ embedding = new Array(768).fill(0.01), reply = 'Respuesta generada por el modelo.' } = {}) {
	return vi.fn(async (url) => {
		if (url.includes(':embedContent')) {
			return { ok: true, json: async () => ({ embedding: { values: embedding } }) };
		}
		if (url.includes(':generateContent')) {
			return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: reply }] } }] }) };
		}
		throw new Error('URL de fetch inesperada: ' + url);
	});
}

function makeEnv({ cachedReply = null, matches = [], docsUrls = null } = {}) {
	return {
		GOOGLE_API_KEY: 'fake-key',
		VECTORIZE: {
			query: vi.fn(async () => ({ matches })),
		},
		garantia_cache: {
			// El namespace guarda dos cosas distintas: las respuestas cacheadas bajo
			// chat:* y el mapa de links de Drive bajo docs:urls.
			get: vi.fn(async (key) => (key === 'docs:urls' ? docsUrls : cachedReply)),
			put: vi.fn(async () => {}),
		},
	};
}

// El mapa de Drive se consulta en todas las respuestas, así que para verificar el
// caché de chat hay que mirar solo las lecturas de esa clave.
function lecturasDeCacheDeChat(env) {
	return env.garantia_cache.get.mock.calls.filter(([key]) => key.startsWith('chat:'));
}

function makeRequest(body) {
	return new Request('http://example.com/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('handleChat', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rechaza mensajes vacíos con 400', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const env = makeEnv();
		const res = await handleChat(makeRequest({ message: '   ' }), env);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Mensaje vacío' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('en el primer mensaje (history vacío) revisa el caché antes de llamar a la IA', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const env = makeEnv({ cachedReply: 'Respuesta cacheada' });
		const res = await handleChat(makeRequest({ message: '¿Qué cubre la garantía de batería?', history: [] }), env);
		const body = await res.json();

		expect(body).toEqual({ reply: 'Respuesta cacheada', cached: true });
		expect(lecturasDeCacheDeChat(env)).toHaveLength(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(env.VECTORIZE.query).not.toHaveBeenCalled();
	});

	it('en el primer mensaje sin caché, consulta Vectorize/Gemini y guarda la respuesta en caché', async () => {
		const fetchMock = mockFetch({
			reply: 'Respuesta generada por el modelo.',
		});
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			cachedReply: null,
			matches: [{ score: 0.8, metadata: { source: 'doc.pdf', text: 'contenido relevante' } }],
		});
		const res = await handleChat(makeRequest({ message: 'pregunta nueva', history: [] }), env);
		const body = await res.json();

		expect(body.cached).toBe(false);
		expect(body.reply).toBe('Respuesta generada por el modelo.');
		expect(env.VECTORIZE.query).toHaveBeenCalledTimes(1);
		expect(env.garantia_cache.put).toHaveBeenCalledTimes(1);
		expect(env.garantia_cache.put.mock.calls[0][1]).toBe('Respuesta generada por el modelo.');

		const embedCall = fetchMock.mock.calls.find(([url]) => url.includes(':embedContent'));
		const embedBody = JSON.parse(embedCall[1].body);
		expect(embedBody.taskType).toBe('RETRIEVAL_QUERY');
	});

	it('no lee ni escribe caché cuando ya hay historial (no es el primer mensaje)', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const env = makeEnv({ cachedReply: 'no debería usarse' });
		const history = [
			{ role: 'user', content: 'primera pregunta' },
			{ role: 'assistant', content: 'primera respuesta' },
		];
		const res = await handleChat(makeRequest({ message: 'segunda pregunta', history }), env);
		const body = await res.json();

		expect(body.cached).toBe(false);
		expect(lecturasDeCacheDeChat(env)).toHaveLength(0);
		expect(env.garantia_cache.put).not.toHaveBeenCalled();
	});

	it('mapea los roles assistant/user del historial a model/user para Gemini', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		const history = [
			{ role: 'user', content: 'primera pregunta' },
			{ role: 'assistant', content: 'primera respuesta' },
		];
		await handleChat(makeRequest({ message: 'segunda pregunta', history }), env);

		const generateCall = fetchMock.mock.calls.find(([url]) => url.includes(':generateContent'));
		const generateBody = JSON.parse(generateCall[1].body);

		expect(generateBody.contents[0]).toEqual({ role: 'user', parts: [{ text: 'primera pregunta' }] });
		expect(generateBody.contents[1]).toEqual({ role: 'model', parts: [{ text: 'primera respuesta' }] });
		expect(generateBody.systemInstruction.parts[0].text).toContain('GarantIA');
	});

	it('convierte en link el documento citado cuando el mapa de Drive está publicado', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Sí, cubre.\n\n📄 Basado en: Toyota 10 - T&C.pdf' }));
		const env = makeEnv({ docsUrls: { 'Toyota 10 - T&C.pdf': 'https://drive.google.com/file/d/abc/view' } });
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toBe('Sí, cubre.\n\n📄 Basado en: [Toyota 10 - T&C.pdf](https://drive.google.com/file/d/abc/view)');
	});

	it('deja la respuesta intacta si el mapa de Drive todavía no se publicó', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: '📄 Basado en: Toyota 10 - T&C.pdf' }));
		const env = makeEnv({ docsUrls: null });
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		expect((await res.json()).reply).toBe('📄 Basado en: Toyota 10 - T&C.pdf');
	});

	it('linkifica el nombre más largo cuando un documento es prefijo de otro', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Ver ABI-502 - Anexo 5.pdf para el detalle.' }));
		const env = makeEnv({
			docsUrls: {
				'ABI-502.pdf': 'https://drive.google.com/file/d/corto/view',
				'ABI-502 - Anexo 5.pdf': 'https://drive.google.com/file/d/largo/view',
			},
		});
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		expect((await res.json()).reply).toBe('Ver [ABI-502 - Anexo 5.pdf](https://drive.google.com/file/d/largo/view) para el detalle.');
	});

	it('aplica los links también a una respuesta que viene del caché', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const env = makeEnv({
			cachedReply: '📄 Basado en: Toyota 10 - T&C.pdf',
			docsUrls: { 'Toyota 10 - T&C.pdf': 'https://drive.google.com/file/d/abc/view' },
		});
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);
		const body = await res.json();

		expect(body.cached).toBe(true);
		expect(body.reply).toBe('📄 Basado en: [Toyota 10 - T&C.pdf](https://drive.google.com/file/d/abc/view)');
	});

	// Devuelve el texto del último turno que se le mandó a Gemini, que es donde
	// handleChat arma el contexto o, si no hubo, el pedido de sugerencias.
	function ultimoPromptEnviado(fetchMock) {
		const generateCall = fetchMock.mock.calls.find(([url]) => url.includes(':generateContent'));
		const generateBody = JSON.parse(generateCall[1].body);
		return generateBody.contents[generateBody.contents.length - 1].parts[0].text;
	}

	it('filtra matches de Vectorize con score bajo y responde igual sin contexto', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			matches: [{ score: 0.3, metadata: { source: 'doc.pdf', text: 'poco relevante' } }],
		});
		const res = await handleChat(makeRequest({ message: 'pregunta rara', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toBe('Respuesta generada por el modelo.');

		const prompt = ultimoPromptEnviado(fetchMock);
		expect(prompt).toContain('No hay ningún documento en la base que responda esto');
		expect(prompt).not.toContain('poco relevante');
	});

	// El umbral se subió de 0.55 a 0.72 midiendo contra el índice real. El acierto
	// más flojo medido puntuó 0.727, así que el corte va apenas debajo: se prefiere
	// dejar entrar ruido —que el modelo descarta— antes que perder un documento útil.
	it('deja pasar un match de 0.727 y descarta uno de 0.70', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			matches: [
				{ score: 0.727, metadata: { source: 'sirve.pdf', text: 'contenido que sirve' } },
				{ score: 0.7, metadata: { source: 'no-sirve.pdf', text: 'contenido que no sirve' } },
			],
		});
		await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		const prompt = ultimoPromptEnviado(fetchMock);
		expect(prompt).toContain('contenido que sirve');
		expect(prompt).not.toContain('contenido que no sirve');
	});

	// Los rangos de score de aciertos y de falsos positivos se solapan, así que el
	// modelo puede recibir contexto y aun así no poder responder. En ese caso el
	// técnico tiene que llevarse igual la referencia.
	it('ofrece los documentos más cercanos también cuando sí hay contexto', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			matches: [{ score: 0.74, metadata: { source: 'ABI-501.pdf', text: 'barra deportiva' } }],
		});
		await handleChat(makeRequest({ message: 'pérdida de líquido en amortiguadores', history: [] }), env);

		const prompt = ultimoPromptEnviado(fetchMock);
		expect(prompt).toContain('barra deportiva');
		expect(prompt).toContain('Lo más parecido que hay en la base');
		expect(prompt).toContain('- ABI-501.pdf');
	});

	it('ofrece los documentos más cercanos cuando no hay nada por encima del umbral', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			matches: [
				{ score: 0.71, metadata: { source: 'ABI-501.pdf', text: 'barra deportiva' } },
				{ score: 0.7, metadata: { source: 'ABI-501.pdf', text: 'otro fragmento del mismo' } },
				{ score: 0.69, metadata: { source: 'ABI-502-C.pdf', text: 'campaña' } },
			],
		});
		await handleChat(makeRequest({ message: 'pérdida de líquido en amortiguadores', history: [] }), env);

		const prompt = ultimoPromptEnviado(fetchMock);
		expect(prompt).toContain('Lo más parecido que hay en la base');
		expect(prompt).toContain('- ABI-501.pdf');
		expect(prompt).toContain('- ABI-502-C.pdf');
		// El mismo documento aparece en dos fragmentos y se sugiere una sola vez.
		expect(prompt.match(/- ABI-501\.pdf/g)).toHaveLength(1);
	});

	// El bot repregunta modelo, síntoma y kilometraje de a uno, así que el último
	// mensaje suele ser el menos informativo de la conversación. Buscar solo con
	// ese descarta justo lo que el técnico ya había contado.
	it('busca con el caso acumulado y no solo con el último mensaje', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		const history = [
			{ role: 'user', content: 'hilux srx 2020' },
			{ role: 'assistant', content: '¿Cuál es el síntoma?' },
			{ role: 'user', content: 'perdida de liquido amortiguadores' },
			{ role: 'assistant', content: '¿Kilometraje?' },
		];
		await handleChat(makeRequest({ message: '130.000 km', history }), env);

		const embedCall = fetchMock.mock.calls.find(([url]) => url.includes(':embedContent'));
		const consulta = JSON.parse(embedCall[1].body).content.parts[0].text;

		expect(consulta).toContain('hilux srx 2020');
		expect(consulta).toContain('perdida de liquido amortiguadores');
		expect(consulta).toContain('130.000 km');
		// Las repreguntas del bot no son parte del caso y ensuciarían la búsqueda.
		expect(consulta).not.toContain('¿Kilometraje?');
	});

	it('sin historial, la consulta de búsqueda es el mensaje tal cual', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		await handleChat(makeRequest({ message: 'garantía de baterías', history: [] }), env);

		const embedCall = fetchMock.mock.calls.find(([url]) => url.includes(':embedContent'));
		expect(JSON.parse(embedCall[1].body).content.parts[0].text).toBe('garantía de baterías');
	});
});
