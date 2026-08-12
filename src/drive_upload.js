// Sube los documentos de docs/ a Google Drive y publica el mapa archivo -> URL en KV,
// para que el chat pueda citar cada fuente con un link abrible.
//
// Uso:
//   node src/drive_upload.js ./docs        sube lo que falte y actualiza el mapa en KV
//   node src/drive_upload.js --solo-mapa   no sube nada, solo reescribe el mapa en KV

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { getAccessToken } from './google_auth.js';

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID || 'd1f39512c3204c818120f62cff06e8d4';

const CARPETA_DRIVE = 'GarantIA - Documentos';
const EXTENSIONES = ['.pdf', '.xlsx', '.xls', '.docx'];

// Los nombres de archivo son únicos en todo el corpus salvo un duplicado exacto,
// así que alcanza con guardar el mapa por nombre, sin la ruta.
const MANIFIESTO = '.drive-manifest.json';

// El Worker lee esta clave para resolver el link de cada documento citado.
const KV_KEY = 'docs:urls';

const MIME_POR_EXTENSION = {
	'.pdf': 'application/pdf',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.xls': 'application/vnd.ms-excel',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const REINTENTOS_MAX = 4;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Manifiesto ───────────────────────────────────────────
// Mismo criterio que el checkpoint de la ingesta: anotar lo hecho para que una
// corrida cortada retome donde quedó en vez de volver a subir 233 MB.

function leerManifiesto() {
	if (!existsSync(MANIFIESTO)) return {};
	try {
		return JSON.parse(readFileSync(MANIFIESTO, 'utf8'));
	} catch {
		console.warn('  ⚠️  Manifiesto ilegible, se ignora y se sube todo de nuevo.');
		return {};
	}
}

function guardarManifiesto(manifiesto) {
	writeFileSync(MANIFIESTO, JSON.stringify(manifiesto, null, 2));
}

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
	return webViewLink;
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

	const manifiesto = leerManifiesto();

	if (process.argv.includes('--solo-mapa')) {
		await publicarMapa(manifiesto);
		console.log(`\n✅ Mapa republicado en KV: ${Object.keys(manifiesto).length} documentos\n`);
		return;
	}

	const target = process.argv[2] || './docs';
	const archivos = buscarArchivos(target);
	const pendientes = archivos.filter((f) => !manifiesto[basename(f)]);

	console.log(`\n🔍 Archivos encontrados: ${archivos.length}`);
	if (archivos.length !== pendientes.length) {
		console.log(`   ⏭️  Ya subidos: ${archivos.length - pendientes.length}`);
		console.log(`   📋 Pendientes: ${pendientes.length}`);
	}

	if (pendientes.length === 0) {
		console.log('\n✅ No queda nada por subir.\n');
		await publicarMapa(manifiesto);
		return;
	}

	const token = await getAccessToken();
	const carpetaId = await obtenerOCrearCarpeta(token);

	let subidos = 0;
	let errores = 0;

	for (const [i, archivo] of pendientes.entries()) {
		const nombre = basename(archivo);
		process.stdout.write(`  ⬆️  ${i + 1}/${pendientes.length} ${nombre.slice(0, 60)}...\r`);
		try {
			manifiesto[nombre] = await subirArchivo(token, archivo, carpetaId);
			// Se anota apenas termina cada archivo, así una caída no pierde lo subido.
			guardarManifiesto(manifiesto);
			subidos++;
		} catch (err) {
			console.error(`\n  ❌ ${nombre}: ${err.message}`);
			errores++;
		}
	}

	await publicarMapa(manifiesto);

	console.log(`\n\n🎉 Subida completa`);
	console.log(`   ✅ Documentos subidos:  ${subidos}`);
	console.log(`   ❌ Con error:           ${errores}`);
	console.log(`   🔗 Mapa en KV:          ${Object.keys(manifiesto).length} documentos\n`);
}

main().catch((err) => {
	console.error(`\n❌ ${err.message}`);
	console.error('   Lo subido hasta acá quedó en el manifiesto. Volvé a correr el script para retomar.\n');
	process.exit(1);
});
