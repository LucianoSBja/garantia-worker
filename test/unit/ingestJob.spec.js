import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IngestJob } from '../../src/ingest_job_do.js';

// Google/Drive/Gemini todo por fetch — un solo router, como ya hace el
// resto del proyecto (ver mockFetch en handleChat.spec.js).
function mockFetch({ embedding = new Array(768).fill(0.01), cuotaEnIntentos = [] } = {}) {
	let intentoEmbed = 0;
	return vi.fn(async (url, opciones = {}) => {
		const u = String(url);

		if (u.includes('oauth2.googleapis.com/token')) {
			return { ok: true, json: async () => ({ access_token: 'fake-access-token' }) };
		}

		if (u.includes(':embedContent')) {
			intentoEmbed++;
			if (cuotaEnIntentos.includes(intentoEmbed)) {
				return { ok: false, status: 429, json: async () => ({}) };
			}
			return { ok: true, status: 200, json: async () => ({ embedding: { values: embedding } }) };
		}

		if (u.includes('drive/v3/files?q=')) {
			return { ok: true, status: 200, json: async () => ({ files: [{ id: 'carpeta-1', name: 'GarantIA - Documentos' }] }) };
		}

		if (u.includes('upload/drive/v3/files') && u.includes('uploadType=resumable')) {
			return {
				ok: true,
				status: 200,
				headers: { get: (h) => (h === 'location' ? 'https://upload.example/sesion-1' : null) },
				json: async () => ({}),
			};
		}

		if (u === 'https://upload.example/sesion-1') {
			return { ok: true, status: 200, json: async () => ({ id: 'drive-file-id-1' }) };
		}

		if (u.includes('/permissions')) {
			return { ok: true, status: 200, json: async () => ({}) };
		}

		if (u.includes('drive/v3/files/drive-file-id-1?fields=webViewLink')) {
			return { ok: true, status: 200, json: async () => ({ webViewLink: 'https://drive.google.com/file/d/drive-file-id-1/view?usp=drivesdk' }) };
		}

		throw new Error('URL de fetch inesperada en el test: ' + u);
	});
}

// Vectorize falso con estado real (Map id->vector): permite precargar
// "chunks ya indexados" para probar el backfill (contarChunksExistentes)
// y confirmar que un delete realmente saca las ids del store.
function makeVectorizeFalso() {
	const store = new Map();
	return {
		_store: store,
		upsert: vi.fn(async (vectores) => {
			for (const v of vectores) store.set(v.id, v);
			return { mutationId: 'm1' };
		}),
		deleteByIds: vi.fn(async (ids) => {
			for (const id of ids) store.delete(id);
			return { mutationId: 'm2' };
		}),
		getByIds: vi.fn(async (ids) => ids.filter((id) => store.has(id)).map((id) => store.get(id))),
	};
}

function makeEnv() {
	return {
		GOOGLE_API_KEY: 'fake-gemini-key',
		GOOGLE_OAUTH_CLIENT_ID: 'client-id',
		GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
		GOOGLE_REFRESH_TOKEN: 'refresh-token',
		VECTORIZE: makeVectorizeFalso(),
		garantia_cache: (() => {
			const kv = new Map();
			return {
				get: vi.fn(async (key) => kv.get(key) ?? null),
				put: vi.fn(async (key, value) => {
					kv.set(key, value);
				}),
			};
		})(),
	};
}

// Storage falso (Map en memoria) + env falso, listos para instanciar un DO
// en cada test. setAlarm solo registra la llamada: los tests disparan
// alarm() a mano, no dependen de que un timer real dispare nada.
function makeStateYEnv() {
	const datos = new Map();
	const state = {
		storage: {
			get: vi.fn(async (key) => datos.get(key)),
			put: vi.fn(async (key, value) => {
				datos.set(key, value);
			}),
			delete: vi.fn(async (key) => datos.delete(key)),
			setAlarm: vi.fn(async () => {}),
		},
	};
	return { state, env: makeEnv() };
}

function iniciarRequest({ fileName = 'ABI-999.pdf', text, file = new File(['contenido binario de prueba'], 'ABI-999.pdf', { type: 'application/pdf' }) } = {}) {
	const form = new FormData();
	form.append('fileName', fileName);
	form.append('mimeType', file.type);
	form.append('text', text ?? Array.from({ length: 500 }, (_, i) => `palabra${i}`).join(' '));
	form.append('file', file);
	return new Request('https://do/iniciar', { method: 'POST', body: form });
}

describe('IngestJob', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetch());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('iniciar sube a Drive, chunkea y arranca el job en estado embedding', async () => {
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);

		const res = await job.iniciar(iniciarRequest());
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.total).toBeGreaterThan(0);
		expect(state.storage.setAlarm).toHaveBeenCalled();

		const estado = await job.estado();
		const estadoBody = await estado.json();
		expect(estadoBody.estado).toBe('embedding');
		expect(estadoBody.nextIndex).toBe(0);
		// El panel arma un overlay optimista con esto mientras docs:index en KV
		// no propagó todavía (ver admin_html.js) — sin driveFileId acá, el botón
		// de preview quedaba deshabilitado justo después de subir.
		expect(estadoBody.driveFileId).toBe('drive-file-id-1');
		expect(estadoBody.driveUrl).toBeTruthy();
	});

	it('rechaza un segundo iniciar mientras hay un job embedding en curso', async () => {
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest());

		const segundo = await job.iniciar(iniciarRequest({ fileName: 'otro.pdf' }));
		expect(segundo.status).toBe(409);
	});

	it('cada alarm() embebe un chunk, hace upsert y avanza nextIndex', async () => {
		vi.stubGlobal('fetch', mockFetch());
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest({ text: Array.from({ length: 850 }, (_, i) => `palabra${i}`).join(' ') }));

		const antes = await job.estado();
		const totalChunks = (await antes.json()).total;
		expect(totalChunks).toBeGreaterThan(1);

		await job.alarm();

		expect(env.VECTORIZE.upsert).toHaveBeenCalledTimes(1);
		const [[vectores]] = env.VECTORIZE.upsert.mock.calls;
		expect(vectores[0].id).toBe('ABI999pdf-0');
		expect(vectores[0].metadata.chunk).toBe(0);

		const estado = await (await job.estado()).json();
		expect(estado.nextIndex).toBe(1);
		expect(estado.estado).toBe('embedding');
	});

	it('procesa todos los chunks y termina en done, con docs:index y docs:urls actualizados', async () => {
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		// Texto chico -> un solo chunk, para no tener que tickear muchas veces.
		await job.iniciar(iniciarRequest({ text: 'contenido de prueba con más de cincuenta caracteres para pasar el filtro de chunking mínimo.' }));

		let estado = await (await job.estado()).json();
		expect(estado.total).toBe(1);

		await job.alarm();

		estado = await (await job.estado()).json();
		expect(estado.estado).toBe('done');

		const indice = JSON.parse(await env.garantia_cache.get('docs:index'));
		expect(indice['ABI-999.pdf']).toMatchObject({ chunks: 1, driveFileId: 'drive-file-id-1' });

		const urls = JSON.parse(await env.garantia_cache.get('docs:urls'));
		expect(urls['ABI-999.pdf']).toBe('https://drive.google.com/file/d/drive-file-id-1/view');
	});

	it('resumible tras un "reinicio": una nueva instancia del DO retoma desde nextIndex guardado', async () => {
		const { state, env } = makeStateYEnv();
		const job1 = new IngestJob(state, env);
		await job1.iniciar(iniciarRequest({ text: Array.from({ length: 850 }, (_, i) => `palabra${i}`).join(' ') }));
		await job1.alarm(); // procesa el chunk 0

		// Simula que el DO se recicló: instancia nueva sobre el MISMO storage.
		const job2 = new IngestJob(state, env);
		const estado = await (await job2.estado()).json();
		expect(estado.nextIndex).toBe(1);

		await job2.alarm(); // debería seguir en el chunk 1, no repetir el 0
		const [, segundaLlamada] = env.VECTORIZE.upsert.mock.calls;
		expect(segundaLlamada[0][0].metadata.chunk).toBe(1);
	});

	it('ante un 429 reintenta el mismo chunk sin avanzar nextIndex', async () => {
		vi.stubGlobal('fetch', mockFetch({ cuotaEnIntentos: [1] })); // el primer intento de embed falla con 429
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest());

		await job.alarm(); // intento 1: 429, no avanza
		let estado = await (await job.estado()).json();
		expect(estado.estado).toBe('embedding');
		expect(estado.nextIndex).toBe(0);
		expect(env.VECTORIZE.upsert).not.toHaveBeenCalled();

		await job.alarm(); // intento 2: ok, avanza
		estado = await (await job.estado()).json();
		expect(estado.nextIndex).toBe(1);
	});

	it('agotados los reintentos de un chunk, el job pasa a error y no reprograma la alarma', async () => {
		vi.stubGlobal('fetch', mockFetch({ cuotaEnIntentos: [1, 2, 3, 4, 5, 6] }));
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest());

		for (let i = 0; i < 6; i++) await job.alarm();

		const estado = await (await job.estado()).json();
		expect(estado.estado).toBe('error');
		expect(estado.error).toBeTruthy();
	});

	it('reintentar solo funciona si el job quedó en error', async () => {
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest());

		const rechazo = await job.reintentar();
		expect(rechazo.status).toBe(400);
	});

	it('un reemplazo con menos chunks que el archivo anterior borra los IDs huérfanos', async () => {
		const { state, env } = makeStateYEnv();
		await env.garantia_cache.put(
			'docs:index',
			JSON.stringify({ 'ABI-999.pdf': { chunks: 5, driveFileId: 'drive-file-id-1', driveUrl: 'https://drive.google.com/file/d/drive-file-id-1/view' } })
		);

		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest({ text: 'contenido nuevo, más corto, con más de cincuenta caracteres para el chunker.' }));
		await job.alarm(); // un solo chunk -> termina y finaliza

		expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['ABI999pdf-1', 'ABI999pdf-2', 'ABI999pdf-3', 'ABI999pdf-4']);
	});

	it('docs:index refleja el ciclo de vida completo: pendiente -> indexado', async () => {
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);

		await job.iniciar(iniciarRequest({ text: 'contenido de prueba con más de cincuenta caracteres para pasar el filtro de chunking mínimo.' }));
		let indice = JSON.parse(await env.garantia_cache.get('docs:index'));
		expect(indice['ABI-999.pdf']).toMatchObject({ estado: 'pendiente', chunks: 1, indexadoEl: null });
		expect(indice['ABI-999.pdf'].subidoEl).toBeTruthy();

		await job.alarm();
		indice = JSON.parse(await env.garantia_cache.get('docs:index'));
		expect(indice['ABI-999.pdf']).toMatchObject({ estado: 'indexado' });
		expect(indice['ABI-999.pdf'].indexadoEl).toBeTruthy();
	});

	it('si el job falla, docs:index queda en error con el mensaje', async () => {
		vi.stubGlobal('fetch', mockFetch({ cuotaEnIntentos: [1, 2, 3, 4, 5, 6] }));
		const { state, env } = makeStateYEnv();
		const job = new IngestJob(state, env);
		await job.iniciar(iniciarRequest());

		for (let i = 0; i < 6; i++) await job.alarm();

		const indice = JSON.parse(await env.garantia_cache.get('docs:index'));
		expect(indice['ABI-999.pdf'].estado).toBe('error');
		expect(indice['ABI-999.pdf'].error).toBeTruthy();
	});

	it('backfill: un archivo subido por la CLI (sin docs:index) se reemplaza actualizando el mismo Drive fileId', async () => {
		const { state, env } = makeStateYEnv();

		// Simula el estado de un documento del corpus original: está en
		// docs:urls (lo subió drive_upload.js) y tiene 3 chunks reales en
		// Vectorize, pero nunca pasó por el panel -> docs:index no lo conoce.
		await env.garantia_cache.put('docs:urls', JSON.stringify({ 'ABI-999.pdf': 'https://drive.google.com/file/d/drive-file-id-1/view' }));
		for (let i = 0; i < 3; i++) {
			await env.VECTORIZE.upsert([{ id: `ABI999pdf-${i}`, values: [0], metadata: { source: 'ABI-999.pdf', text: 'x', chunk: i } }]);
		}

		const job = new IngestJob(state, env);
		// Reemplazo con un solo chunk: debería detectar 3 chunks previos vía
		// el probe (no vía docs:index, que está vacío) y borrar los 2 huérfanos.
		await job.iniciar(iniciarRequest({ text: 'contenido nuevo y más corto, con más de cincuenta caracteres para el chunker.' }));
		await job.alarm();

		// La subida a Drive tiene que haber ido al MISMO fileId (PATCH, no un
		// archivo nuevo) — se confirma indirectamente: el mock de fetch solo
		// tiene una respuesta para uploadType=resumable, y si hubiera intentado
		// crear uno nuevo sin fileIdExistente habría pedido la carpeta primero,
		// lo cual también está mockeado, así que lo que realmente prueba el
		// backfill es el borrado de huérfanos con el conteo correcto:
		expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(['ABI999pdf-1', 'ABI999pdf-2']);

		const indice = JSON.parse(await env.garantia_cache.get('docs:index'));
		expect(indice['ABI-999.pdf']).toMatchObject({ estado: 'indexado', chunks: 1, driveFileId: 'drive-file-id-1' });
	});
});
