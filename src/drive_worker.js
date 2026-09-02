// Subida a Google Drive desde el Worker — GarantIA, panel admin.
//
// Versión fetch-based de src/drive_upload.js: en vez de leer un archivo del
// disco (el script CLI corre en Node, con fs), acá los bytes ya llegaron en
// el body de la request del admin. La lógica de Drive en sí (resumable
// upload, carpeta, permisos públicos) es la misma.
//
// A diferencia del CLI (que solo crea, nunca pisa un archivo existente),
// acá también hace falta ACTUALIZAR el contenido de un archivo ya subido
// cuando el admin reemplaza un documento — así el link en docs:urls no
// cambia y las citas viejas del chat siguen abriendo el archivo correcto.

import { getAccessToken } from './shared/google_oauth.js';

const CARPETA_DRIVE = 'GarantIA - Documentos';
const REINTENTOS_MAX = 4;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedirDrive(token, url, opciones = {}) {
	for (let intento = 0; intento <= REINTENTOS_MAX; intento++) {
		const res = await fetch(url, {
			...opciones,
			headers: { Authorization: `Bearer ${token}`, ...opciones.headers },
		});

		if (res.status === 429 || res.status >= 500) {
			if (intento === REINTENTOS_MAX) throw new Error(`Drive respondió ${res.status} tras ${REINTENTOS_MAX} reintentos`);
			await dormir(2000 * 2 ** intento);
			continue;
		}

		if (!res.ok) throw new Error(`Drive respondió ${res.status}: ${await res.text()}`);
		return res;
	}
}

function limpiarUrl(url) {
	return url ? url.split('?')[0] : url;
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
	return id;
}

// Sesión resumable: POST para crear un archivo nuevo, PATCH para reemplazar
// el contenido de uno existente. El upload simple de Drive corta en 5MB y
// el corpus tiene archivos de hasta ~15MB, así que siempre se usa resumable.
async function iniciarSesionResumable(token, { fileName, carpetaId, fileIdExistente }) {
	if (fileIdExistente) {
		const res = await pedirDrive(token, `https://www.googleapis.com/upload/drive/v3/files/${fileIdExistente}?uploadType=resumable`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		return res.headers.get('location');
	}

	const res = await pedirDrive(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: fileName, parents: [carpetaId] }),
	});
	return res.headers.get('location');
}

// Sube o reemplaza el contenido de un archivo. Devuelve { driveFileId, driveUrl }.
// Si fileIdExistente viene, actualiza ESE archivo (mismo id, mismo link
// público, sin volver a tocar permisos). Si no, crea uno nuevo en la
// carpeta del proyecto y lo hace público.
export async function subirOActualizarArchivo(env, { fileName, mimeType, bytes, fileIdExistente }) {
	const token = await getAccessToken({
		clientId: env.GOOGLE_OAUTH_CLIENT_ID,
		clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
		refreshToken: env.GOOGLE_REFRESH_TOKEN,
	});

	const carpetaId = fileIdExistente ? null : await obtenerOCrearCarpeta(token);
	const destino = await iniciarSesionResumable(token, { fileName, carpetaId, fileIdExistente });
	if (!destino) throw new Error('Drive no devolvió la URL de subida');

	const subida = await fetch(destino, {
		method: 'PUT',
		headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.byteLength) },
		body: bytes,
	});
	if (!subida.ok) throw new Error(`Falló la subida de ${fileName}: ${subida.status} ${await subida.text()}`);

	const { id } = await subida.json();

	if (!fileIdExistente) {
		// Los documentos son públicos por decisión del cliente: sin esto el link
		// solo abre para la cuenta dueña del Drive.
		await pedirDrive(token, `https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ role: 'reader', type: 'anyone' }),
		});
	}

	const meta = await pedirDrive(token, `https://www.googleapis.com/drive/v3/files/${id}?fields=webViewLink`);
	const { webViewLink } = await meta.json();

	return { driveFileId: id, driveUrl: limpiarUrl(webViewLink) };
}

export async function borrarArchivo(env, fileIdExistente) {
	const token = await getAccessToken({
		clientId: env.GOOGLE_OAUTH_CLIENT_ID,
		clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
		refreshToken: env.GOOGLE_REFRESH_TOKEN,
	});
	await pedirDrive(token, `https://www.googleapis.com/drive/v3/files/${fileIdExistente}`, { method: 'DELETE' });
}
