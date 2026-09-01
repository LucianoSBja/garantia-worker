import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleChat } from '../../src/index.js';

// Cada turno hace dos generaciones: primero reescribe la consulta para buscar y
// después redacta la respuesta. Pasar reformulacion: '' simula que esa primera
// falla, que es el caso en que solo tiene que quedar la búsqueda cruda.
function mockFetch({ embedding = new Array(768).fill(0.01), reply = 'Respuesta generada por el modelo.', reformulacion = 'consulta reescrita' } = {}) {
	let generaciones = 0;
	return vi.fn(async (url) => {
		if (url.includes(':embedContent')) {
			return { ok: true, json: async () => ({ embedding: { values: embedding } }) };
		}
		if (url.includes(':generateContent')) {
			const texto = generaciones++ === 0 ? reformulacion : reply;
			return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: texto }] } }] }) };
		}
		throw new Error('URL de fetch inesperada: ' + url);
	});
}

function makeEnv({ cachedReply = null, matches = [], docsUrls = null } = {}) {
	// unirMatches deduplica por id, así que sin id todos los fragmentos colapsan
	// en uno solo. Vectorize siempre devuelve id; los tests no tienen por qué
	// escribirlo a mano salvo que estén probando justamente la deduplicación.
	const conId = matches.map((m, i) => ({ id: `v${i}`, ...m }));
	return {
		GOOGLE_API_KEY: 'fake-key',
		VECTORIZE: {
			query: vi.fn(async () => ({ matches: conId })),
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
		// Dos búsquedas: la consulta cruda y la reescrita.
		expect(env.VECTORIZE.query).toHaveBeenCalledTimes(2);
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

		// La última generación es la de la respuesta; la primera reescribe la consulta
		// y no lleva historial.
		const llamadas = fetchMock.mock.calls.filter(([url]) => url.includes(':generateContent'));
		const generateBody = JSON.parse(llamadas[llamadas.length - 1][1].body);

		expect(generateBody.contents[0]).toEqual({ role: 'user', parts: [{ text: 'primera pregunta' }] });
		expect(generateBody.contents[1]).toEqual({ role: 'model', parts: [{ text: 'primera respuesta' }] });
		expect(generateBody.systemInstruction.parts[0].text).toContain('GarantIA');
	});

	it('convierte en link el documento citado cuando el mapa de Drive está publicado', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Sí, cubre.\n\n📄 Basado en: Toyota 10 - T&C.pdf' }));
		// El documento tiene que estar entre los matches: si no, validarCitas borra
		// la cita por inventada y no queda nada que linkificar.
		const env = makeEnv({
			matches: [{ score: 0.8, metadata: { source: 'Toyota 10 - T&C.pdf', text: 'cobertura' } }],
			docsUrls: { 'Toyota 10 - T&C.pdf': 'https://drive.google.com/file/d/abc/view' },
		});
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toBe('Sí, cubre.\n\n📄 Basado en: [Toyota 10 - T&C.pdf](https://drive.google.com/file/d/abc/view)');
	});

	it('deja la respuesta intacta si el mapa de Drive todavía no se publicó', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: '📄 Basado en: Toyota 10 - T&C.pdf' }));
		const env = makeEnv({
			matches: [{ score: 0.8, metadata: { source: 'Toyota 10 - T&C.pdf', text: 'cobertura' } }],
			docsUrls: null,
		});
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

	// El prompt de la respuesta es el de la ÚLTIMA generación del turno: la primera
	// es la reformulación de la consulta de búsqueda.
	function ultimoPromptEnviado(fetchMock) {
		const llamadas = fetchMock.mock.calls.filter(([url]) => url.includes(':generateContent'));
		const body = JSON.parse(llamadas[llamadas.length - 1][1].body);
		return body.contents[body.contents.length - 1].parts[0].text;
	}

	function consultasBuscadas(fetchMock) {
		return fetchMock.mock.calls
			.filter(([url]) => url.includes(':embedContent'))
			.map(([, opciones]) => JSON.parse(opciones.body).content.parts[0].text);
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

	// Visto en producción: el contexto traía solo ABI-515 y la respuesta citó
	// Toyota 10 - T&C.pdf, que nunca se le pasó. Como la cita se convierte en link
	// a Drive, el técnico abre un PDF que no dice lo que el bot afirmó.
	it('borra la cita cuando el archivo no estuvo en el contexto', async () => {
		vi.stubGlobal(
			'fetch',
			mockFetch({ reply: 'La cobertura aplica por 60 meses.\n📄 Basado en: Toyota 10 - T&C.pdf' })
		);
		const env = makeEnv({
			matches: [{ score: 0.78, metadata: { source: 'ABI-515.pdf', text: 'cadena de distribución' } }],
		});
		const res = await handleChat(makeRequest({ message: 'ruido en la distribución', history: [] }), env);
		const body = await res.json();

		expect(body.reply).not.toContain('Toyota 10 - T&C.pdf');
		expect(body.reply).toContain('La cobertura aplica por 60 meses.');
		expect(body.reply).toContain('no sale de un documento de la base');
	});

	it('conserva la cita cuando el archivo sí estuvo en el contexto', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Está cubierto.\n📄 Basado en: ABI-515.pdf' }));
		const env = makeEnv({
			matches: [{ score: 0.78, metadata: { source: 'ABI-515.pdf', text: 'cadena de distribución' } }],
		});
		const res = await handleChat(makeRequest({ message: 'ruido en la distribución', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toContain('📄 Basado en: ABI-515.pdf');
		expect(body.reply).not.toContain('no sale de un documento de la base');
	});

	// Si cita dos archivos y solo uno es real, se conserva el real en vez de tirar
	// toda la cita: la respuesta igual tiene respaldo parcial.
	it('deja solo los archivos válidos cuando la cita mezcla varios', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Respuesta.\n📄 Basado en: ABI-515.pdf y Toyota 10 - T&C.pdf' }));
		const env = makeEnv({
			matches: [{ score: 0.78, metadata: { source: 'ABI-515.pdf', text: 'cadena' } }],
		});
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toContain('📄 Basado en: ABI-515.pdf');
		expect(body.reply).not.toContain('Toyota 10 - T&C.pdf');
	});

	// Los documentos sugeridos como "lo más parecido" no están en el contexto pero
	// sí se le mostraron al modelo, así que nombrarlos es legítimo.
	it('acepta como cita un documento ofrecido entre los más cercanos', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Mirá esto.\n📄 Basado en: ABI-501.pdf' }));
		const env = makeEnv({
			matches: [{ score: 0.7, metadata: { source: 'ABI-501.pdf', text: 'barra deportiva' } }],
		});
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toContain('📄 Basado en: ABI-501.pdf');
	});

	it('guarda en caché la respuesta ya validada, no la cruda', async () => {
		vi.stubGlobal('fetch', mockFetch({ reply: 'Respuesta.\n📄 Basado en: Inventado.pdf' }));
		const env = makeEnv({
			matches: [{ score: 0.78, metadata: { source: 'ABI-515.pdf', text: 'cadena' } }],
		});
		await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		const [, guardado] = env.garantia_cache.put.mock.calls[0];
		expect(guardado).not.toContain('Inventado.pdf');
	});

	// El técnico escribe síntomas y los documentos de cobertura hablan de
	// componentes. Se busca con las dos redacciones porque cada una recupera cosas
	// distintas: la cruda encuentra boletines técnicos, la reescrita los T&C.
	it('busca dos veces: con la consulta cruda y con la reescrita', async () => {
		const fetchMock = mockFetch({ reformulacion: 'amortiguadores de suspensión, cobertura de garantía' });
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		await handleChat(makeRequest({ message: 'pierde líquido el amortiguador', history: [] }), env);

		expect(consultasBuscadas(fetchMock)).toEqual([
			'pierde líquido el amortiguador',
			'amortiguadores de suspensión, cobertura de garantía',
		]);
		expect(env.VECTORIZE.query).toHaveBeenCalledTimes(2);
	});

	// La reformulación es una mejora, no un requisito: si el modelo devuelve
	// cualquier cosa, tiene que quedar el comportamiento anterior y no romperse.
	it('si la reformulación sale vacía, busca solo con la consulta cruda', async () => {
		const fetchMock = mockFetch({ reformulacion: '' });
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({ matches: [{ score: 0.8, metadata: { source: 'doc.pdf', text: 'contenido' } }] });
		const res = await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		expect(consultasBuscadas(fetchMock)).toEqual(['consulta']);
		expect(env.VECTORIZE.query).toHaveBeenCalledTimes(1);
		expect((await res.json()).reply).toBe('Respuesta generada por el modelo.');
	});

	// Las dos búsquedas suelen traer fragmentos repetidos. Si se colaran duplicados
	// al prompt, el mismo texto ocuparía dos lugares del contexto.
	it('no repite en el contexto un fragmento que devolvieron las dos búsquedas', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({ matches: [{ score: 0.8, metadata: { source: 'doc.pdf', text: 'texto repetido' } }] });
		await handleChat(makeRequest({ message: 'consulta', history: [] }), env);

		const prompt = ultimoPromptEnviado(fetchMock);
		expect(prompt.match(/texto repetido/g)).toHaveLength(1);
	});

	it('la reformulación no arrastra el historial de la conversación', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		const history = [
			{ role: 'user', content: 'hilux srx 2020' },
			{ role: 'assistant', content: '¿Cuál es el síntoma?' },
		];
		await handleChat(makeRequest({ message: 'pierde líquido', history }), env);

		const primera = fetchMock.mock.calls.filter(([url]) => url.includes(':generateContent'))[0];
		const contents = JSON.parse(primera[1].body).contents;
		expect(contents).toHaveLength(1);
		expect(contents[0].parts[0].text).toBe('hilux srx 2020. pierde líquido');
	});

	// Con 512 las respuestas largas se cortaban a la mitad y se perdía la línea de
	// la fuente, que va al final. La más larga medida usó 1131 tokens.
	it('pide suficientes tokens de salida para una respuesta larga', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		await handleChat(makeRequest({ message: 'listame todo lo que cubre toyota 10', history: [] }), makeEnv());

		const generacion = fetchMock.mock.calls.filter(([url]) => url.includes(':generateContent')).pop();
		expect(JSON.parse(generacion[1].body).generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(1200);
	});

	// Sin versión en la clave, un deploy que cambia el prompt sigue sirviendo por
	// una hora las respuestas de la lógica anterior y parece no haber surtido efecto.
	it('la clave de caché lleva la versión de la lógica de respuesta', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const env = makeEnv({ cachedReply: null });
		await handleChat(makeRequest({ message: 'Qué Cubre Toyota 10', history: [] }), env);

		const [clave] = env.garantia_cache.put.mock.calls[0];
		expect(clave).toMatch(/^chat:v\d+:qué cubre toyota 10$/);
		expect(lecturasDeCacheDeChat(env)[0][0]).toBe(clave);
	});

	it('sin historial, la consulta de búsqueda es el mensaje tal cual', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv();
		await handleChat(makeRequest({ message: 'garantía de baterías', history: [] }), env);

		const embedCall = fetchMock.mock.calls.find(([url]) => url.includes(':embedContent'));
		expect(JSON.parse(embedCall[1].body).content.parts[0].text).toBe('garantía de baterías');
	});

	// Verificado en producción: bajo una ráfaga de consultas simultáneas, Gemini
	// devuelve 429 (RESOURCE_EXHAUSTED) en la cuota por minuto y, sin reintento,
	// eso tiraba el turno entero como "Error interno" — la causa real detrás de
	// los reportes de "no responde".
	it('reintenta ante un 429 transitorio de Gemini en vez de fallar el turno', async () => {
		let embeddings = 0;
		const fetchMock = vi.fn(async (url) => {
			if (url.includes(':embedContent')) {
				embeddings++;
				if (embeddings === 1) {
					return { status: 429, ok: false, json: async () => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }) };
				}
				return { status: 200, ok: true, json: async () => ({ embedding: { values: new Array(768).fill(0.01) } }) };
			}
			return { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Respuesta.' }] } }] }) };
		});
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({ matches: [{ score: 0.8, metadata: { source: 'doc.pdf', text: 'contenido' } }] });

		const res = await handleChat(makeRequest({ message: 'garantía de baterías', history: [] }), env);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.reply).toBeDefined();
	});
});
