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
