import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChat } from '../../src/index.js';

function makeEnv({ cachedReply = null, matches = [] } = {}) {
	return {
		AI: {
			run: vi.fn(async (model) => {
				if (model === '@cf/baai/bge-m3') {
					return { data: [[0.1, 0.2, 0.3]] };
				}
				return { response: 'Respuesta generada por el modelo.' };
			}),
		},
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
	it('rechaza mensajes vacíos con 400', async () => {
		const env = makeEnv();
		const res = await handleChat(makeRequest({ message: '   ' }), env);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Mensaje vacío' });
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it('en el primer mensaje (history vacío) revisa el caché antes de llamar a la IA', async () => {
		const env = makeEnv({ cachedReply: 'Respuesta cacheada' });
		const res = await handleChat(makeRequest({ message: '¿Qué cubre la garantía de batería?', history: [] }), env);
		const body = await res.json();

		expect(body).toEqual({ reply: 'Respuesta cacheada', cached: true });
		expect(env.garantia_cache.get).toHaveBeenCalledTimes(1);
		expect(env.AI.run).not.toHaveBeenCalled();
		expect(env.VECTORIZE.query).not.toHaveBeenCalled();
	});

	it('en el primer mensaje sin caché, consulta Vectorize/IA y guarda la respuesta en caché', async () => {
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
	});

	it('no lee ni escribe caché cuando ya hay historial (no es el primer mensaje)', async () => {
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

	it('filtra matches de Vectorize con score bajo y responde igual sin contexto', async () => {
		const env = makeEnv({
			matches: [{ score: 0.3, metadata: { source: 'doc.pdf', text: 'poco relevante' } }],
		});
		const res = await handleChat(makeRequest({ message: 'pregunta rara', history: [] }), env);
		const body = await res.json();

		expect(body.reply).toBe('Respuesta generada por el modelo.');

		const llmCall = env.AI.run.mock.calls.find(([model]) => model === '@cf/meta/llama-3.2-3b-instruct');
		const userMessage = llmCall[1].messages.find((m) => m.role === 'user');
		expect(userMessage.content).toContain('No hay documentos relevantes');
	});
});
