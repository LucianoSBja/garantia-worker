import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { GeminiRateLimiter } from '../../src/index.js';

function acquire(tipo) {
	return new Request('https://limiter/acquire', { method: 'POST', body: JSON.stringify({ tipo }) });
}

describe('GeminiRateLimiter', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('deja pasar sin esperar mientras hay tokens en la ráfaga', async () => {
		const limiter = new GeminiRateLimiter();
		for (let i = 0; i < 10; i++) {
			const res = await limiter.fetch(acquire('embed'));
			expect((await res.json()).esperaMs).toBe(0);
		}
	});

	it('agotada la ráfaga, hace esperar al siguiente pedido', async () => {
		const limiter = new GeminiRateLimiter();
		for (let i = 0; i < 10; i++) await limiter.fetch(acquire('embed'));

		const promesa = limiter.fetch(acquire('embed'));
		await vi.advanceTimersByTimeAsync(2100);
		const res = await promesa;

		expect((await res.json()).esperaMs).toBeGreaterThan(0);
	});

	it('con el tiempo se recupera y vuelve a dejar pasar sin esperar', async () => {
		const limiter = new GeminiRateLimiter();
		for (let i = 0; i < 10; i++) await limiter.fetch(acquire('embed'));

		// Un minuto entero a 30/min repone la ráfaga completa.
		vi.setSystemTime(Date.now() + 60_000);

		const res = await limiter.fetch(acquire('embed'));
		expect((await res.json()).esperaMs).toBe(0);
	});

	// Google cuota embeddings y generación por separado (el error trae
	// "requests_per_minute_per_base_model" nombrando el modelo puntual), así
	// que agotar uno no puede frenar al otro.
	it('los baldes de embed y generate son independientes', async () => {
		const limiter = new GeminiRateLimiter();
		for (let i = 0; i < 10; i++) await limiter.fetch(acquire('embed'));

		const res = await limiter.fetch(acquire('generate'));
		expect((await res.json()).esperaMs).toBe(0);
	});

	it('rechaza un tipo de cupo desconocido', async () => {
		const limiter = new GeminiRateLimiter();
		const res = await limiter.fetch(acquire('otro'));
		expect(res.status).toBe(400);
	});
});
