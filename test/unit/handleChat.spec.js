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

function makeEnv({ cachedReply = null, matches = [] } = {}) {
	return {
		GOOGLE_API_KEY: 'fake-key',
		VECTORIZE: {
			query: vi.fn(async () => ({ matches })),
		},
		garantia_cache: {
			get: vi.fn(async () => cachedReply),
			put: vi.fn(async () => {}),
		},
	};
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
		expect(env.garantia_cache.get).toHaveBeenCalledTimes(1);
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
		expect(env.garantia_cache.get).not.toHaveBeenCalled();
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

	it('filtra matches de Vectorize con score bajo y responde igual sin contexto', async () => {
		const fetchMock = mockFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = makeEnv({
			matches: [{ score: 0.3, metadata: { source: 'doc.pdf', text: 'poco relevante' } }],
		});
		const res = await handleChat(makeRequest({ message: 'pregunta rara', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toBe('Respuesta generada por el modelo.');

		const generateCall = fetchMock.mock.calls.find(([url]) => url.includes(':generateContent'));
		const generateBody = JSON.parse(generateCall[1].body);
		const lastMessage = generateBody.contents[generateBody.contents.length - 1];
		expect(lastMessage.parts[0].text).toContain('No hay documentos relevantes');
	});
});
