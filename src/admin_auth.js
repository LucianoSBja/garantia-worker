// Auth del panel admin — GarantIA. Un solo usuario admin, login + sesión +
// recuperación de contraseña por email.
//
// La password nunca vive en texto plano en ningún lado. El hash vigente
// vive en KV (`admin:password`, `{hash, salt}`) — no como secret del
// Worker — porque "olvidé mi contraseña" necesita que el propio Worker
// pueda escribir una password nueva en tiempo de ejecución, y los secrets
// de `wrangler secret put` son de solo lectura desde el código: no hay
// binding que permita cambiarlos. `ADMIN_PASSWORD_HASH`/`ADMIN_PASSWORD_SALT`
// siguen existiendo como secrets, pero solo como semilla inicial: se usan
// nada más si KV todavía no tiene `admin:password` (antes del primer
// reseteo, o en un deploy nuevo).
//
// La sesión es un token aleatorio en KV con TTL, no una cookie stateless
// firmada: el proyecto ya usa KV para todo, y así el logout es un simple
// delete — con HMAC stateless invalidar antes de que expire exigiría de
// todos modos una blocklist en KV.

import { enviarEmail } from './email_resend.js';

const SESSION_COOKIE = 'admin_session';
const SESSION_PREFIX = 'admin:session:';
const SESSION_TTL_SEGUNDOS = 12 * 60 * 60; // 12h

const LOCKOUT_KEY = 'admin:login:fails';
const LOCKOUT_TTL_SEGUNDOS = 15 * 60;
const LOCKOUT_MAX_INTENTOS = 5;

const KV_KEY_PASSWORD = 'admin:password';

const RESET_PREFIX = 'admin:reset:';
const RESET_TTL_SEGUNDOS = 15 * 60;
const RESET_MIN_PASSWORD_LEN = 8;

const FORGOT_COUNT_KEY = 'admin:forgot:count';
const FORGOT_TTL_SEGUNDOS = 15 * 60;
const FORGOT_MAX_INTENTOS = 3;

const CORS_ADMIN_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// Mensaje genérico, igual exista o no la cuenta: no hay que darle a un
// atacante una forma de confirmar cuál es el email del admin.
const MENSAJE_FORGOT_GENERICO = 'Si el email corresponde a la cuenta admin, te llega un link para restablecer la contraseña.';

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

async function credencialesVigentes(env) {
	const crudo = await env.garantia_cache.get(KV_KEY_PASSWORD);
	if (crudo) {
		try {
			return JSON.parse(crudo);
		} catch {
			/* cae a la semilla de abajo si KV tiene basura */
		}
	}
	if (env.ADMIN_PASSWORD_HASH && env.ADMIN_PASSWORD_SALT) {
		return { hash: env.ADMIN_PASSWORD_HASH, salt: env.ADMIN_PASSWORD_SALT };
	}
	return null;
}

async function passwordValida(env, passwordIngresada) {
	const credenciales = await credencialesVigentes(env);
	if (!credenciales) return false;
	const hash = await hashPassword(passwordIngresada, credenciales.salt);
	return compararEnTiempoConstante(hash, credenciales.hash);
}

async function guardarPasswordNueva(env, passwordNueva) {
	const salt = crypto.randomUUID();
	const hash = await hashPassword(passwordNueva, salt);
	await env.garantia_cache.put(KV_KEY_PASSWORD, JSON.stringify({ hash, salt }));
}

// ── Lockout de intentos fallidos (login) ─────────────────
// Contador global (no por IP): un solo admin legítimo no necesita el costo
// extra de trackear IPs, y esto ya frena el escaneo automático de /admin.

async function contador(env, key) {
	const valor = await env.garantia_cache.get(key);
	return valor ? parseInt(valor, 10) || 0 : 0;
}

async function incrementarContador(env, key, ttlSegundos) {
	const actual = await contador(env, key);
	await env.garantia_cache.put(key, String(actual + 1), { expirationTtl: ttlSegundos });
}

async function limpiarIntentosFallidos(env) {
	await env.garantia_cache.delete(LOCKOUT_KEY);
}

async function hayLockout(env) {
	return (await contador(env, LOCKOUT_KEY)) >= LOCKOUT_MAX_INTENTOS;
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

// ── Rutas: login / logout ─────────────────────────────────

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
		await incrementarContador(env, LOCKOUT_KEY, LOCKOUT_TTL_SEGUNDOS);
		return Response.json({ error: 'Password incorrecta' }, { status: 401, headers: CORS_ADMIN_HEADERS });
	}

	await limpiarIntentosFallidos(env);
	const token = await crearSesion(env);
	return Response.json({ ok: true }, { status: 200, headers: { ...CORS_ADMIN_HEADERS, 'Set-Cookie': cookieSesion(token) } });
}

export async function manejarLogout(request, env) {
	const token = leerCookie(request, SESSION_COOKIE);
	await destruirSesion(env, token);
	return Response.json({ ok: true }, { status: 200, headers: { ...CORS_ADMIN_HEADERS, 'Set-Cookie': cookieLogout() } });
}

// ── Rutas: olvidé mi contraseña ───────────────────────────

export async function manejarForgotPassword(request, env) {
	let email;
	try {
		({ email } = await request.json());
	} catch {
		return Response.json({ error: 'Body inválido' }, { status: 400, headers: CORS_ADMIN_HEADERS });
	}

	// Límite de envíos por ventana: el email del admin es un recurso real
	// (buzón, cuota de Resend), no algo que dejar golpear sin freno.
	if ((await contador(env, FORGOT_COUNT_KEY)) >= FORGOT_MAX_INTENTOS) {
		return Response.json({ ok: true, mensaje: MENSAJE_FORGOT_GENERICO }, { status: 200, headers: CORS_ADMIN_HEADERS });
	}
	await incrementarContador(env, FORGOT_COUNT_KEY, FORGOT_TTL_SEGUNDOS);

	const coincide = typeof email === 'string' && env.ADMIN_EMAIL && email.trim().toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();

	if (coincide) {
		const token = crypto.randomUUID();
		await env.garantia_cache.put(RESET_PREFIX + token, '1', { expirationTtl: RESET_TTL_SEGUNDOS });

		const origen = new URL(request.url).origin;
		const link = `${origen}/admin?reset=${token}`;

		await enviarEmail(env, {
			to: env.ADMIN_EMAIL,
			subject: 'Restablecer tu contraseña de GarantIA',
			html: `<p>Pediste restablecer la contraseña del panel admin de GarantIA.</p>
<p><a href="${link}">Elegir una contraseña nueva</a></p>
<p>El link vence en 15 minutos. Si no fuiste vos, ignorá este mail — la contraseña actual sigue funcionando.</p>`,
		});
	}

	// Misma respuesta exista o no la cuenta, y aunque el envío falle: no hay
	// que delatar por el código de estado si el email coincidía.
	return Response.json({ ok: true, mensaje: MENSAJE_FORGOT_GENERICO }, { status: 200, headers: CORS_ADMIN_HEADERS });
}

export async function manejarResetPassword(request, env) {
	let token, password;
	try {
		({ token, password } = await request.json());
	} catch {
		return Response.json({ error: 'Body inválido' }, { status: 400, headers: CORS_ADMIN_HEADERS });
	}

	if (typeof token !== 'string' || !(await env.garantia_cache.get(RESET_PREFIX + token))) {
		return Response.json({ error: 'El link venció o ya se usó. Pedí uno nuevo.' }, { status: 400, headers: CORS_ADMIN_HEADERS });
	}

	if (typeof password !== 'string' || password.length < RESET_MIN_PASSWORD_LEN) {
		return Response.json({ error: `La contraseña tiene que tener al menos ${RESET_MIN_PASSWORD_LEN} caracteres` }, { status: 400, headers: CORS_ADMIN_HEADERS });
	}

	await guardarPasswordNueva(env, password);
	await env.garantia_cache.delete(RESET_PREFIX + token); // un solo uso
	await limpiarIntentosFallidos(env);

	return Response.json({ ok: true }, { status: 200, headers: CORS_ADMIN_HEADERS });
}
