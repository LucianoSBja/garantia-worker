// Auth del panel admin — GarantIA. Un solo usuario admin, login + sesión.
//
// La password nunca vive en texto plano en ningún lado: ADMIN_PASSWORD_HASH
// y ADMIN_PASSWORD_SALT son secrets del Worker, calculados una vez a mano
// (SHA-256(password + salt)) y cargados con `wrangler secret put`.
//
// La sesión es un token aleatorio en KV con TTL, no una cookie stateless
// firmada: el proyecto ya usa KV para todo, y así el logout es un simple
// delete — con HMAC stateless invalidar antes de que expire exigiría de
// todos modos una blocklist en KV.

const SESSION_COOKIE = 'admin_session';
const SESSION_PREFIX = 'admin:session:';
const SESSION_TTL_SEGUNDOS = 12 * 60 * 60; // 12h

const LOCKOUT_KEY = 'admin:login:fails';
const LOCKOUT_TTL_SEGUNDOS = 15 * 60;
const LOCKOUT_MAX_INTENTOS = 5;

const CORS_ADMIN_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// ── Hashing y comparación ────────────────────────────────

export async function hashPassword(password, salt) {
	const bytes = new TextEncoder().encode(password + salt);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Comparación en tiempo constante entre dos strings hex de igual longitud
// esperada. No es una garantía formal contra timing attacks (la rama de
// longitud distinta sí es temprana), pero es un único admin de bajo valor,
// no una superficie multiusuario — best-effort, documentado como tal.
export function compararEnTiempoConstante(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

async function passwordValida(env, passwordIngresada) {
	if (!env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_SALT) return false;
	const hash = await hashPassword(passwordIngresada, env.ADMIN_PASSWORD_SALT);
	return compararEnTiempoConstante(hash, env.ADMIN_PASSWORD_HASH);
}

// ── Lockout de intentos fallidos ─────────────────────────
// Contador global (no por IP): un solo admin legítimo no necesita el costo
// extra de trackear IPs, y esto ya frena el escaneo automático de /admin.

async function intentosFallidos(env) {
	const valor = await env.garantia_cache.get(LOCKOUT_KEY);
	return valor ? parseInt(valor, 10) || 0 : 0;
}

async function registrarIntentoFallido(env) {
	const actual = await intentosFallidos(env);
	await env.garantia_cache.put(LOCKOUT_KEY, String(actual + 1), { expirationTtl: LOCKOUT_TTL_SEGUNDOS });
}

async function limpiarIntentosFallidos(env) {
	await env.garantia_cache.delete(LOCKOUT_KEY);
}

async function hayLockout(env) {
	return (await intentosFallidos(env)) >= LOCKOUT_MAX_INTENTOS;
}

// ── Sesión ────────────────────────────────────────────────

function leerCookie(request, nombre) {
	const header = request.headers.get('Cookie') || '';
	for (const parte of header.split(';')) {
		const [clave, ...resto] = parte.trim().split('=');
		if (clave === nombre) return resto.join('=');
	}
	return null;
}

function cookieSesion(token) {
	return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_TTL_SEGUNDOS}`;
}

function cookieLogout() {
	return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`;
}

async function crearSesion(env) {
	const token = crypto.randomUUID();
	await env.garantia_cache.put(SESSION_PREFIX + token, '1', { expirationTtl: SESSION_TTL_SEGUNDOS });
	return token;
}

async function destruirSesion(env, token) {
	if (token) await env.garantia_cache.delete(SESSION_PREFIX + token);
}

async function sesionValida(request, env) {
	const token = leerCookie(request, SESSION_COOKIE);
	if (!token) return false;
	return Boolean(await env.garantia_cache.get(SESSION_PREFIX + token));
}

// Helper único para proteger rutas /admin/api/*: null si está autorizado,
// una Response 401 lista para devolver si no.
export async function requireAdminSession(request, env) {
	if (await sesionValida(request, env)) return null;
	return Response.json({ error: 'No autorizado' }, { status: 401, headers: CORS_ADMIN_HEADERS });
}

// ── Rutas ─────────────────────────────────────────────────

export async function manejarLogin(request, env) {
	if (await hayLockout(env)) {
		return Response.json({ error: 'Demasiados intentos. Esperá unos minutos.' }, { status: 429, headers: CORS_ADMIN_HEADERS });
	}

	let password;
	try {
		({ password } = await request.json());
	} catch {
		return Response.json({ error: 'Body inválido' }, { status: 400, headers: CORS_ADMIN_HEADERS });
	}

	if (typeof password !== 'string' || !(await passwordValida(env, password))) {
		await registrarIntentoFallido(env);
		return Response.json({ error: 'Password incorrecta' }, { status: 401, headers: CORS_ADMIN_HEADERS });
	}

	await limpiarIntentosFallidos(env);
	const token = await crearSesion(env);
	return Response.json(
		{ ok: true },
		{ status: 200, headers: { ...CORS_ADMIN_HEADERS, 'Set-Cookie': cookieSesion(token) } }
	);
}

export async function manejarLogout(request, env) {
	const token = leerCookie(request, SESSION_COOKIE);
	await destruirSesion(env, token);
	return Response.json({ ok: true }, { status: 200, headers: { ...CORS_ADMIN_HEADERS, 'Set-Cookie': cookieLogout() } });
}
