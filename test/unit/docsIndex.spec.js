import { describe, it, expect, vi } from 'vitest';
import { leerIndice, actualizarIndice, eliminarDeIndice, leerMapaUrls, actualizarMapaUrls, eliminarDeMapaUrls, extraerDriveFileId } from '../../src/docs_index.js';

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

describe('docs:index', () => {
	it('empieza vacío si la clave no existe', async () => {
		const env = makeEnv();
		expect(await leerIndice(env)).toEqual({});
	});

	it('actualizarIndice mergea sin pisar campos no tocados', async () => {
		const env = makeEnv();
		await actualizarIndice(env, 'a.pdf', { estado: 'pendiente', chunks: 3 });
		await actualizarIndice(env, 'a.pdf', { estado: 'indexado' });

		const indice = await leerIndice(env);
		expect(indice['a.pdf']).toEqual({ estado: 'indexado', chunks: 3 });
	});

	it('eliminarDeIndice saca solo la entrada pedida', async () => {
		const env = makeEnv();
		await actualizarIndice(env, 'a.pdf', { chunks: 1 });
		await actualizarIndice(env, 'b.pdf', { chunks: 2 });

		await eliminarDeIndice(env, 'a.pdf');

		const indice = await leerIndice(env);
		expect(indice).toEqual({ 'b.pdf': { chunks: 2 } });
	});

	it('un valor corrupto en KV no rompe la lectura, cae a vacío', async () => {
		const env = makeEnv();
		await env.garantia_cache.put('docs:index', 'esto no es json');
		expect(await leerIndice(env)).toEqual({});
	});
});

describe('docs:urls', () => {
	it('actualizarMapaUrls / eliminarDeMapaUrls', async () => {
		const env = makeEnv();
		await actualizarMapaUrls(env, 'a.pdf', 'https://drive.google.com/file/d/abc123/view');
		expect(await leerMapaUrls(env)).toEqual({ 'a.pdf': 'https://drive.google.com/file/d/abc123/view' });

		await eliminarDeMapaUrls(env, 'a.pdf');
		expect(await leerMapaUrls(env)).toEqual({});
	});
});

describe('extraerDriveFileId', () => {
	it('saca el fileId de un webViewLink típico', () => {
		expect(extraerDriveFileId('https://drive.google.com/file/d/1AbC-XyZ_123/view')).toBe('1AbC-XyZ_123');
	});

	it('funciona aunque el link traiga query params', () => {
		expect(extraerDriveFileId('https://drive.google.com/file/d/1AbC-XyZ_123/view?usp=drivesdk')).toBe('1AbC-XyZ_123');
	});

	it('devuelve null si la URL no tiene el patrón esperado', () => {
		expect(extraerDriveFileId('https://drive.google.com/drive/folders/xyz')).toBeNull();
	});

	it('devuelve null con undefined/vacío sin tirar excepción', () => {
		expect(extraerDriveFileId(undefined)).toBeNull();
		expect(extraerDriveFileId('')).toBeNull();
	});
});
