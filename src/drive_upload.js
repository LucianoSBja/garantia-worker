// Sube los documentos de docs/ a Google Drive y publica el mapa archivo -> URL en KV,
// para que el chat pueda citar cada fuente con un link abrible.
//
// Uso:
//   node src/drive_upload.js ./docs        sube lo que falte y actualiza el mapa en KV
//   node src/drive_upload.js --solo-mapa   no sube nada, solo reescribe el mapa en KV

import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, extname, join } from 'path';
import { getAccessToken } from './google_auth.js';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID || 'd1f39512c3204c818120f62cff06e8d4';

const CARPETA_DRIVE = 'GarantIA - Documentos';
const EXTENSIONES = ['.pdf', '.xlsx', '.xls', '.docx', '.pptx'];

// El Worker lee esta clave para resolver el link de cada documento citado.
const KV_KEY = 'docs:urls';

const MIME_POR_EXTENSION = {
	'.pdf': 'application/pdf',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const REINTENTOS_MAX = 4;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Drive ────────────────────────────────────────────────

async function pedirDrive(token, url, opciones = {}) {
	for (let intento = 0; intento <= REINTENTOS_MAX; intento++) {
		const res = await fetch(url, {
			...opciones,
			headers: { Authorization: `Bearer ${token}`, ...opciones.headers },
		});

		// Drive limita por proyecto y por usuario; ante saturación conviene esperar
		// en vez de abandonar la corrida.
		if (res.status === 429 || res.status >= 500) {
			if (intento === REINTENTOS_MAX) throw new Error(`Drive respondió ${res.status} tras ${REINTENTOS_MAX} reintentos`);
			await dormir(2000 * 2 ** intento);
			continue;
		}

		if (!res.ok) throw new Error(`Drive respondió ${res.status}: ${await res.text()}`);
		return res;
	}
}

async function obtenerOCrearCarpeta(token) {
	const q = encodeURIComponent(`name='${CARPETA_DRIVE}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
	const res = await pedirDrive(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
	const { files } = await res.json();

	if (files?.length > 0) return files[0].id;

	const creada = await pedirDrive(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: CARPETA_DRIVE, mimeType: 'application/vnd.google-apps.folder' }),
	});
	const { id } = await creada.json();
	console.log(`📁 Carpeta creada en Drive: ${CARPETA_DRIVE}`);
	return id;
}

// El webViewLink que devuelve Drive arrastra parámetros de sesión, y en los
// archivos de Office viene además ouid, que es el identificador de la cuenta
// dueña del Drive. Como estas URLs terminan a la vista en el chat, se conserva
// solo la parte que identifica al documento. Verificado: abren igual sin query.
function limpiarUrl(url) {
	return url ? url.split('?')[0] : url;
}

// Qué hay ya subido. Se consulta a Drive en vez de llevar un registro local:
// Drive permite nombres repetidos en una carpeta, así que un archivo de estado
// perdido —un clon nuevo, un repo limpio— haría subir el corpus entero de nuevo
// y dejaría 207 duplicados.
async function listarCarpeta(token, carpetaId) {
	const yaSubidos = {};
	const repetidos = [];
	let pageToken;

	do {
		const params = new URLSearchParams({
			q: `'${carpetaId}' in parents and trashed=false`,
			fields: 'nextPageToken,files(name,webViewLink)',
			pageSize: '1000',
		});
		if (pageToken) params.set('pageToken', pageToken);

		const res = await pedirDrive(token, `https://www.googleapis.com/drive/v3/files?${params}`);
		const data = await res.json();

		for (const archivo of data.files || []) {
			if (yaSubidos[archivo.name]) repetidos.push(archivo.name);
			else yaSubidos[archivo.name] = limpiarUrl(archivo.webViewLink);
		}
		pageToken = data.nextPageToken;
	} while (pageToken);

	if (repetidos.length > 0) {
		console.warn(`\n⚠️  Hay ${repetidos.length} nombres duplicados en Drive de alguna corrida previa.`);
		console.warn('   Se usa la primera copia de cada uno; conviene borrar las sobrantes a mano.');
	}

	return yaSubidos;
}

// El upload simple corta en 5 MB y en el corpus hay 11 archivos que lo superan
// (el más grande, 14,5 MB). Usamos resumable para todos y evitamos la bifurcación.
async function subirArchivo(token, filePath, carpetaId) {
	const nombre = basename(filePath);
	const mime = MIME_POR_EXTENSION[extname(filePath).toLowerCase()];
	const contenido = readFileSync(filePath);

	const inicio = await pedirDrive(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: nombre, parents: [carpetaId] }),
	});

	const destino = inicio.headers.get('location');
	if (!destino) throw new Error('Drive no devolvió la URL de subida');

	// La URL resumable ya lleva la autorización adentro, no hay que mandar el Bearer.
	const subida = await fetch(destino, {
		method: 'PUT',
		headers: { 'Content-Type': mime, 'Content-Length': String(contenido.length) },
		body: contenido,
	});
	if (!subida.ok) throw new Error(`Falló la subida de ${nombre}: ${subida.status} ${await subida.text()}`);

	const { id } = await subida.json();

	// Los documentos son públicos por decisión del cliente: sin esto el link solo
	// abre para la cuenta dueña del Drive.
	await pedirDrive(token, `https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ role: 'reader', type: 'anyone' }),
	});

	const meta = await pedirDrive(token, `https://www.googleapis.com/drive/v3/files/${id}?fields=webViewLink`);
	const { webViewLink } = await meta.json();
	return limpiarUrl(webViewLink);
}

// ── KV ───────────────────────────────────────────────────
// El mapa entero va en una sola clave (~25 KB para 207 documentos): así el Worker
// hace una lectura por consulta en vez de una por documento citado.

async function publicarMapa(mapa) {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${KV_KEY}`,
		{
			method: 'PUT',
			headers: { Authorization: `Bearer ${API_TOKEN}` },
			body: (() => {
				const form = new FormData();
				form.append('value', JSON.stringify(mapa));
				form.append('metadata', '{}');
				return form;
			})(),
		}
	);
	const data = await res.json();
	if (!data.success) throw new Error('No se pudo escribir el mapa en KV: ' + JSON.stringify(data.errors));
}

// ── Archivos ─────────────────────────────────────────────

function buscarArchivos(dir) {
	let resultados = [];
	for (const entrada of readdirSync(dir)) {
		const ruta = join(dir, entrada);
		if (statSync(ruta).isDirectory()) resultados = resultados.concat(buscarArchivos(ruta));
		else if (EXTENSIONES.includes(extname(ruta).toLowerCase())) resultados.push(ruta);
	}
	return resultados;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
	if (!ACCOUNT_ID || !API_TOKEN) {
		console.error('❌ Faltan CF_ACCOUNT_ID o CF_API_TOKEN en el .env');
		process.exit(1);
	}
	if (!process.env.GOOGLE_REFRESH_TOKEN) {
		console.error('❌ Falta GOOGLE_REFRESH_TOKEN. Corré primero: node src/google_auth.js');
		process.exit(1);
	}

	const token = await getAccessToken();
	const carpetaId = await obtenerOCrearCarpeta(token);
	const mapa = await listarCarpeta(token, carpetaId);

	if (process.argv.includes('--solo-mapa')) {
		await publicarMapa(mapa);
		console.log(`\n✅ Mapa republicado en KV: ${Object.keys(mapa).length} documentos\n`);
		return;
	}

	const target = process.argv[2] || './docs';
	const archivos = buscarArchivos(target);
	const pendientes = archivos.filter((f) => !mapa[basename(f)]);

	console.log(`\n🔍 Archivos encontrados: ${archivos.length}`);
	if (archivos.length !== pendientes.length) {
		console.log(`   ⏭️  Ya están en Drive: ${archivos.length - pendientes.length}`);
		console.log(`   📋 Pendientes:        ${pendientes.length}`);
	}

	let subidos = 0;
	let errores = 0;

	for (const [i, archivo] of pendientes.entries()) {
		const nombre = basename(archivo);
		process.stdout.write(`  ⬆️  ${i + 1}/${pendientes.length} ${nombre.slice(0, 60)}...\r`);
		try {
			mapa[nombre] = await subirArchivo(token, archivo, carpetaId);
			subidos++;
		} catch (err) {
			console.error(`\n  ❌ ${nombre}: ${err.message}`);
			errores++;
		}
	}

	await publicarMapa(mapa);

	console.log(`\n\n🎉 Subida completa`);
	console.log(`   ✅ Documentos subidos:  ${subidos}`);
	console.log(`   ❌ Con error:           ${errores}`);
	console.log(`   🔗 Mapa en KV:          ${Object.keys(mapa).length} documentos\n`);
}

main().catch((err) => {
	console.error(`\n❌ ${err.message}`);
	console.error('   Lo subido hasta acá ya está en Drive. Volvé a correr el script para retomar.\n');
	process.exit(1);
});
