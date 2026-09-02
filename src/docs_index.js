// Índice de "qué archivos están subidos" para el panel admin — GarantIA.
//
// Vectorize no tiene forma de listar por `source` (no hay metadata index
// creado para esa key, ver CLAUDE.md), así que el panel necesita su propio
// registro. Vive en una sola clave KV (mismo patrón que docs:urls): así el
// panel hace una lectura por vista en vez de una por documento.

const KV_KEY_INDICE = 'docs:index';

export async function leerIndice(env) {
	const crudo = await env.garantia_cache.get(KV_KEY_INDICE);
	if (!crudo) return {};
	try {
		return JSON.parse(crudo);
	} catch {
		return {};
	}
}

export async function actualizarIndice(env, fileName, datos) {
	const indice = await leerIndice(env);
	indice[fileName] = { ...indice[fileName], ...datos };
	await env.garantia_cache.put(KV_KEY_INDICE, JSON.stringify(indice));
	return indice[fileName];
}

export async function eliminarDeIndice(env, fileName) {
	const indice = await leerIndice(env);
	delete indice[fileName];
	await env.garantia_cache.put(KV_KEY_INDICE, JSON.stringify(indice));
}

// ── docs:urls (mapa nombre -> link de Drive que linkifica el chat) ──
// Centralizado acá porque el DO de ingesta y las rutas de borrado leen y
// escriben el mismo mapa; antes estaba duplicado en los dos lugares.

const KV_KEY_URLS = 'docs:urls';

export async function leerMapaUrls(env) {
	const crudo = await env.garantia_cache.get(KV_KEY_URLS);
	if (!crudo) return {};
	try {
		return JSON.parse(crudo);
	} catch {
		return {};
	}
}

export async function actualizarMapaUrls(env, fileName, url) {
	const mapa = await leerMapaUrls(env);
	mapa[fileName] = url;
	await env.garantia_cache.put(KV_KEY_URLS, JSON.stringify(mapa));
}

export async function eliminarDeMapaUrls(env, fileName) {
	const mapa = await leerMapaUrls(env);
	delete mapa[fileName];
	await env.garantia_cache.put(KV_KEY_URLS, JSON.stringify(mapa));
}

// El link que guarda docs:urls tiene la forma
// https://drive.google.com/file/d/{fileId}/view — de ahí se puede sacar el
// fileId sin llamar a la API de Drive. Hace falta para "backfill": un
// documento subido por la CLI (drive_upload.js) antes de que existiera el
// panel no tiene entrada en docs:index, así que docs:urls es la única pista
// de qué fileId de Drive le corresponde si el admin lo reemplaza desde acá.
export function extraerDriveFileId(url) {
	return url?.match(/\/file\/d\/([^/]+)/)?.[1] || null;
}
