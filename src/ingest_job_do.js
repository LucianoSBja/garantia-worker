// Durable Object IngestJob — GarantIA, panel admin.
//
// Instancia única (idFromName('current'), mismo patrón que GeminiRateLimiter):
// el propio DO sabe si ya hay un job corriendo y rechaza uno nuevo, sin
// necesitar una flag externa en KV ni IDs de job en la URL.
//
// alarm() procesa UN chunk por tick y reprograma la siguiente alarma desde
// adentro del propio try/catch, antes de retornar. Es a propósito: si
// alarm() deja escapar una excepción, Cloudflare reintenta con backoff
// (2s, hasta 6 veces) y DESPUÉS deja de disparar la alarma para siempre
// (confirmado contra la doc vigente de Durable Objects Alarms). Un 429 de
// Gemini es esperable y no puede depender de esa red de seguridad.
//
// Rate limiting propio, desacoplado de GEMINI_LIMITER a propósito: si este
// job vaciara el cupo compartido con el chat en vivo, haría esperar a un
// técnico — exactamente lo que GeminiRateLimiter existe para evitar del
// lado del chat. Pacing lento tipo CLI (ver src/ingest.js).
//
// docs:index se escribe en tres momentos, no solo al terminar: 'pendiente'
// al iniciar (nombre, chunks totales y datos de Drive ya se conocen ahí),
// 'indexado' al finalizar, 'error' si el job se cae. Así la tabla del panel
// puede mostrar el estado real de un documento sin depender de que el
// admin tenga la pestaña abierta mirando el polling del job.

import { chunkearPorNombreDeArchivo } from './chunking.js';
import { subirOActualizarArchivo } from './drive_worker.js';
import { leerIndice, actualizarIndice, leerMapaUrls, actualizarMapaUrls, extraerDriveFileId } from './docs_index.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_EMBED_MODEL = 'gemini-embedding-001';
const GEMINI_EMBED_DIMENSIONS = 768;

// Mismo pacing que la ingesta CLI (src/ingest.js): sin nadie esperando en
// vivo, no hay apuro, y así no se acerca al límite por minuto de Gemini.
const PACING_MS = 700;
const ESPERA_BASE_MS = 5000;
const REINTENTOS_CHUNK_MAX = 5;

// Backfill de documentos subidos por la CLI antes de que existiera el panel
// (no tienen entrada en docs:index): probar en lotes cuántos chunks existen
// de verdad en Vectorize, para poder borrar los huérfanos si el reemplazo
// tiene menos contenido. Acotado — ver contarChunksExistentes().
const LOTE_PROBE = 50;
const MAX_CHUNKS_PROBE = 400;

export function sanitizarNombre(fileName) {
	return fileName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}

export function idDeChunk(fileName, indice) {
	return `${sanitizarNombre(fileName)}-${indice}`;
}

async function embedChunk(env, texto) {
	const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:embedContent`, {
		method: 'POST',
		headers: { 'x-goog-api-key': env.GOOGLE_API_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			content: { parts: [{ text: texto }] },
			taskType: 'RETRIEVAL_DOCUMENT',
			outputDimensionality: GEMINI_EMBED_DIMENSIONS,
		}),
	});

	if (res.status === 429) {
		const err = new Error('Cuota de Gemini agotada');
		err.esCuota = true;
		throw err;
	}

	const data = await res.json();
	if (!data.embedding?.values) throw new Error('Error embedding: ' + JSON.stringify(data));
	return data.embedding.values;
}

// Cuenta cuántos chunks de fileName existen realmente en Vectorize, probando
// IDs determinísticos en lotes hasta encontrar el primer hueco. Se usa solo
// cuando docs:index no tiene la entrada (documento subido por la CLI, nunca
// tocado desde el panel) — con panel-uploads el conteo ya se conoce.
async function contarChunksExistentes(env, fileName) {
	let total = 0;
	for (let inicio = 0; inicio < MAX_CHUNKS_PROBE; inicio += LOTE_PROBE) {
		const cantidad = Math.min(LOTE_PROBE, MAX_CHUNKS_PROBE - inicio);
		const ids = Array.from({ length: cantidad }, (_, i) => idDeChunk(fileName, inicio + i));
		const encontrados = new Set((await env.VECTORIZE.getByIds(ids)).map((v) => v.id));

		let contiguos = 0;
		for (const id of ids) {
			if (!encontrados.has(id)) break;
			contiguos++;
		}
		total += contiguos;
		if (contiguos < ids.length) break;
	}
	return total;
}

export class IngestJob {
	constructor(state, env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request) {
		const url = new URL(request.url);
		try {
			if (url.pathname === '/iniciar' && request.method === 'POST') return await this.iniciar(request);
			if (url.pathname === '/estado') return await this.estado();
			if (url.pathname === '/reintentar' && request.method === 'POST') return await this.reintentar();
			return Response.json({ error: 'ruta desconocida' }, { status: 404 });
		} catch (err) {
			return Response.json({ error: err.message }, { status: 500 });
		}
	}

	async iniciar(request) {
		const jobActual = await this.state.storage.get('job');
		if (jobActual && jobActual.estado === 'embedding') {
			return Response.json({ error: 'Ya hay una ingesta en curso: ' + jobActual.fileName }, { status: 409 });
		}

		const form = await request.formData();
		const fileName = form.get('fileName');
		const text = form.get('text');
		let mimeType = form.get('mimeType');
		const file = form.get('file');

		if (!fileName || !text || !file) {
			return Response.json({ error: 'Faltan campos: fileName, text y file son obligatorios' }, { status: 400 });
		}
		if (!mimeType || mimeType === 'application/octet-stream') {
			mimeType = MIME_POR_EXTENSION[extensionDe(fileName)] || 'application/octet-stream';
		}

		const chunks = chunkearPorNombreDeArchivo(fileName, text);
		if (chunks.length === 0) {
			return Response.json({ error: 'El archivo no tiene contenido indexable' }, { status: 400 });
		}

		const indice = await leerIndice(this.env);
		let entradaAnterior = indice[fileName] || null;

		// Backfill: el archivo ya está en el corpus (docs:urls lo tiene) pero
		// nunca pasó por el panel, así que no hay entrada en docs:index. Se
		// reconstruye lo necesario para que el reemplazo actualice el mismo
		// archivo de Drive en vez de crear uno duplicado.
		if (!entradaAnterior) {
			const urls = await leerMapaUrls(this.env);
			if (urls[fileName]) {
				const driveFileId = extraerDriveFileId(urls[fileName]);
				const chunksPrevios = await contarChunksExistentes(this.env, fileName);
				if (driveFileId || chunksPrevios > 0) {
					entradaAnterior = { driveFileId, driveUrl: urls[fileName], chunks: chunksPrevios };
				}
			}
		}

		let driveInfo;
		try {
			const bytes = await file.arrayBuffer();
			driveInfo = await subirOActualizarArchivo(this.env, {
				fileName,
				mimeType,
				bytes,
				fileIdExistente: entradaAnterior?.driveFileId || null,
			});
		} catch (err) {
			return Response.json({ error: 'Falló la subida a Drive: ' + err.message }, { status: 502 });
		}

		const ahora = new Date().toISOString();
		await actualizarIndice(this.env, fileName, {
			estado: 'pendiente',
			chunks: chunks.length,
			driveFileId: driveInfo.driveFileId,
			driveUrl: driveInfo.driveUrl,
			subidoEl: ahora,
			indexadoEl: null,
			error: null,
		});

		const job = {
			estado: 'embedding',
			fileName,
			chunks,
			nextIndex: 0,
			total: chunks.length,
			driveFileId: driveInfo.driveFileId,
			driveUrl: driveInfo.driveUrl,
			chunksAnteriores: entradaAnterior ? entradaAnterior.chunks : null,
			intentosChunkActual: 0,
			error: null,
			iniciadoEl: Date.now(),
			terminadoEl: null,
		};
		await this.state.storage.put('job', job);
		await this.state.storage.setAlarm(Date.now() + 10);

		return Response.json({ ok: true, total: chunks.length });
	}

	async estado() {
		const job = await this.state.storage.get('job');
		if (!job) return Response.json({ estado: 'inactivo' });
		return Response.json({
			estado: job.estado,
			fileName: job.fileName,
			nextIndex: job.nextIndex,
			total: job.total,
			error: job.error,
			// driveFileId/driveUrl ya se conocen desde iniciar() (Drive se sube
			// antes de crear el job, ver arriba) — el panel los necesita para el
			// overlay optimista de la tabla, así el botón de preview no queda
			// deshabilitado mientras docs:index en KV todavía no propagó.
			driveFileId: job.driveFileId,
			driveUrl: job.driveUrl,
		});
	}

	async reintentar() {
		const job = await this.state.storage.get('job');
		if (!job || job.estado !== 'error') {
			return Response.json({ error: 'No hay ningún job en error para reintentar' }, { status: 400 });
		}
		job.estado = 'embedding';
		job.error = null;
		job.intentosChunkActual = 0;
		await this.state.storage.put('job', job);
		await actualizarIndice(this.env, job.fileName, { estado: 'pendiente', error: null });
		await this.state.storage.setAlarm(Date.now() + 10);
		return Response.json({ ok: true, nextIndex: job.nextIndex, total: job.total });
	}

	async alarm() {
		const job = await this.state.storage.get('job');
		if (!job || job.estado !== 'embedding') return;

		try {
			const texto = job.chunks[job.nextIndex];
			let embedding;
			try {
				embedding = await embedChunk(this.env, texto);
			} catch (err) {
				if (err.esCuota && job.intentosChunkActual < REINTENTOS_CHUNK_MAX) {
					job.intentosChunkActual++;
					await this.state.storage.put('job', job);
					const espera = ESPERA_BASE_MS * 2 ** job.intentosChunkActual;
					await this.state.storage.setAlarm(Date.now() + espera);
					return;
				}
				throw err;
			}

			await this.env.VECTORIZE.upsert([
				{
					id: idDeChunk(job.fileName, job.nextIndex),
					values: embedding,
					metadata: { source: job.fileName, text: texto, chunk: job.nextIndex },
				},
			]);

			job.nextIndex++;
			job.intentosChunkActual = 0;
			await this.state.storage.put('job', job);

			if (job.nextIndex < job.total) {
				await this.state.storage.setAlarm(Date.now() + PACING_MS);
			} else {
				await this.finalizar(job);
			}
		} catch (err) {
			job.estado = 'error';
			job.error = err.message;
			job.terminadoEl = Date.now();
			await this.state.storage.put('job', job);
			await actualizarIndice(this.env, job.fileName, { estado: 'error', error: err.message });
			// Sin reprogramar alarma a propósito: el job queda en 'error' hasta
			// que el admin pida /reintentar. Dejar que Cloudflare reintente solo
			// agotaría sus 6 reintentos nativos y apagaría la alarma para siempre.
		}
	}

	async finalizar(job) {
		try {
			if (job.chunksAnteriores !== null && job.chunksAnteriores > job.total) {
				const idsHuerfanos = [];
				for (let i = job.total; i < job.chunksAnteriores; i++) idsHuerfanos.push(idDeChunk(job.fileName, i));
				await this.env.VECTORIZE.deleteByIds(idsHuerfanos);
			}

			await actualizarIndice(this.env, job.fileName, {
				estado: 'indexado',
				chunks: job.total,
				driveFileId: job.driveFileId,
				driveUrl: job.driveUrl,
				indexadoEl: new Date().toISOString(),
			});
			await actualizarMapaUrls(this.env, job.fileName, job.driveUrl);

			job.estado = 'done';
			job.terminadoEl = Date.now();
			await this.state.storage.put('job', job);
		} catch (err) {
			job.estado = 'error';
			job.error = 'Falló al finalizar: ' + err.message;
			job.terminadoEl = Date.now();
			await this.state.storage.put('job', job);
			await actualizarIndice(this.env, job.fileName, { estado: 'error', error: job.error });
		}
	}
}

const MIME_POR_EXTENSION = {
	'.pdf': 'application/pdf',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function extensionDe(fileName) {
	const i = fileName.lastIndexOf('.');
	return i === -1 ? '' : fileName.slice(i).toLowerCase();
}
