import { describe, it, expect, vi } from 'vitest';
import { leerPoliticaMarkdown, guardarPoliticaMarkdown } from '../../src/politica_modal.js';

function makeEnv() {
	const kv = new Map();
	return {
		garantia_cache: {
			get: vi.fn(async (key) => kv.get(key) ?? null),
			put: vi.fn(async (key, value) => {
				kv.set(key, value);
			}),
		},
	};
}

describe('politica_modal', () => {
	it('sin nada guardado, devuelve el texto por defecto (no vacío)', async () => {
		const env = makeEnv();
		const markdown = await leerPoliticaMarkdown(env);
		expect(markdown.length).toBeGreaterThan(0);
		expect(markdown).toContain('Responsabilidad del propietario');
	});

	it('guardar y releer devuelve exactamente lo guardado, no el default', async () => {
		const env = makeEnv();
		await guardarPoliticaMarkdown(env, '## Otro texto\n\nContenido editado.');
		const markdown = await leerPoliticaMarkdown(env);
		expect(markdown).toBe('## Otro texto\n\nContenido editado.');
	});
});
