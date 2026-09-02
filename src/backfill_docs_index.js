// Completa docs:index a partir de docs:urls — GarantIA.
// Uso: node src/backfill_docs_index.js
//
// Los documentos subidos por la CLI (ingest.js + drive_upload.js) antes de
// que existiera el panel admin, o agregados por la CLI más adelante sin
// pasar por el panel, no tienen entrada en docs:index — el panel no los
// lista en la tabla ni conoce su driveFileId real (ver "Panel admin" en
// CLAUDE.md, sección de backfill-al-reemplazar). Este script completa lo
// que falta: para cada archivo en docs:urls sin entrada en docs:index,
// saca el driveFileId del link (extraerDriveFileId), prueba cuántos chunks
// tiene realmente en Vectorize (mismo criterio que contarChunksExistentes
// en src/ingest_job_do.js, pero contra la REST API en vez del binding
// nativo — acá el límite es 20 ids por request, no el de 1000/lote que
// tiene el binding) y trae la fecha de creación del archivo en Drive para
// subidoEl/indexadoEl.
//
// Correrlo de nuevo no duplica ni pisa nada: solo completa entradas que
// falten. Es la vía para que "Política de Garantía y Mantenimiento" y el
// resto del corpus original aparezcan en el Historial del panel aunque
// nunca se hayan tocado desde ahí.
//
// Un archivo con 0 chunks en Vectorize (típicamente un boletín reemplazado,
// ya borrado del índice a mano — ver "Un boletín reemplazado..." en
// CLAUDE.md) NO se omite: se agrega igual, con estado 'error' y el detalle
// en el mensaje. La alternativa —dejarlo afuera de docs:index— lo volvía
// invisible: seguía en Drive y en docs:urls, pero sin ningún rastro en el
// panel ni forma de revisarlo o borrarlo desde ahí.

import { getAccessToken } from './shared/google_oauth.js';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID || 'd1f39512c3204c818120f62cff06e8d4';
const INDEX_NAME = 'garantia-index-gemini';

const LOTE_PROBE = 20; // límite de la REST API de Vectorize, no el del binding nativo (1000)
const MAX_CHUNKS_PROBE = 400;
const PAUSA_MS = 150;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitizarNombre(fileName) {
	return fileName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}

function extraerDriveFileId(url) {
	return url?.match(/\/file\/d\/([^/]+)/)?.[1] || null;
}

async function leerKV(key) {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`, {
		headers: { Authorization: `Bearer ${API_TOKEN}` },
	});
	if (res.status === 404) return null;
	try {
		return JSON.parse(await res.text());
	} catch {
		return null;
	}
}

async function escribirKV(key, valor) {
	const form = new FormData();
	form.append('value', JSON.stringify(valor));
	form.append('metadata', '{}');
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${API_TOKEN}` },
		body: form,
	});
	const data = await res.json();
	if (!data.success) throw new Error(`No se pudo escribir ${key}: ` + JSON.stringify(data.errors));
}

async function contarChunksExistentes(fileName) {
	let total = 0;
	for (let inicio = 0; inicio < MAX_CHUNKS_PROBE; inicio += LOTE_PROBE) {
		const cantidad = Math.min(LOTE_PROBE, MAX_CHUNKS_PROBE - inicio);
		const ids = Array.from({ length: cantidad }, (_, i) => `${sanitizarNombre(fileName)}-${inicio + i}`);
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/get_by_ids`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids }),
		});
		const data = await res.json();
		if (!data.success) throw new Error('get_by_ids falló: ' + JSON.stringify(data.errors));

		const encontrados = new Set(data.result.map((v) => v.id));
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

async function fechaCreacionDrive(token, fileId) {
	if (!fileId) return null;
	const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=createdTime`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) return null;
	const data = await res.json();
	return data.createdTime || null;
}

async function main() {
	if (!ACCOUNT_ID || !API_TOKEN) {
		console.error('❌ Faltan CF_ACCOUNT_ID o CF_API_TOKEN en el .env');
		process.exit(1);
	}
	if (!process.env.GOOGLE_REFRESH_TOKEN) {
		console.error('❌ Falta GOOGLE_REFRESH_TOKEN. Corré primero: node src/google_auth.js');
		process.exit(1);
	}

	const urls = (await leerKV('docs:urls')) || {};
	const indice = (await leerKV('docs:index')) || {};

	const faltantes = Object.keys(urls).filter((nombre) => !indice[nombre]);
	console.log(`\n🔍 ${Object.keys(urls).length} documentos en docs:urls, ${faltantes.length} sin entrada en docs:index\n`);

	if (faltantes.length === 0) {
		console.log('✅ No hay nada para completar.\n');
		return;
	}

	const token = await getAccessToken({
		clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
		clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
		refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
	});

	let completados = 0;
	let sinVectorizar = 0;

	for (const [i, nombre] of faltantes.entries()) {
		process.stdout.write(`  📄 ${i + 1}/${faltantes.length} ${nombre.slice(0, 55).padEnd(55)}\r`);

		const driveFileId = extraerDriveFileId(urls[nombre]);
		const chunks = await contarChunksExistentes(nombre);
		const fecha = await fechaCreacionDrive(token, driveFileId);

		// chunks === 0 no se omite: se deja igual en docs:index, marcado como
		// 'error', para que el admin lo vea en la tabla y decida —normalmente
		// es un boletín reemplazado que ya se borró de Vectorize a mano (ver
		// CLAUDE.md), y sin esto quedaba invisible: en Drive, citado en
		// docs:urls, pero sin ningún rastro en el panel ni forma de limpiarlo
		// desde ahí.
		if (chunks === 0) {
			indice[nombre] = {
				estado: 'error',
				chunks: 0,
				driveFileId,
				driveUrl: urls[nombre],
				subidoEl: fecha,
				indexadoEl: null,
				error: 'Sin fragmentos en Vectorize — probablemente un documento reemplazado/descontinuado ya sacado del índice a mano.',
			};
			sinVectorizar++;
			await dormir(PAUSA_MS);
			continue;
		}

		indice[nombre] = {
			estado: 'indexado',
			chunks,
			driveFileId,
			driveUrl: urls[nombre],
			subidoEl: fecha,
			indexadoEl: fecha,
			error: null,
		};
		completados++;
		await dormir(PAUSA_MS);
	}

	await escribirKV('docs:index', indice);

	console.log(`\n\n🎉 Backfill completo`);
	console.log(`   ✅ Indexados:        ${completados}`);
	console.log(`   ⚠️  Sin vectorizar:   ${sinVectorizar} (agregados igual, marcados 'error' para poder revisarlos/borrarlos desde el panel)\n`);
}

main().catch((err) => {
	console.error(`\n❌ ${err.message}\n`);
	process.exit(1);
});
