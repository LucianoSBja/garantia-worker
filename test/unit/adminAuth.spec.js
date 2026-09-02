import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	hashPassword,
	compararEnTiempoConstante,
	requireAdminSession,
	manejarLogin,
	manejarLogout,
	manejarForgotPassword,
	manejarResetPassword,
} from '../../src/admin_auth.js';

// KV falso en memoria — ignora expirationTtl a propósito: los tests de este
// archivo no ejercitan el vencimiento real (es responsabilidad de Cloudflare,
// no de esta lógica), solo el conteo/borrado que sí maneja el código.
function makeKv() {
	const store = new Map();
	return {
		get: vi.fn(async (key) => store.get(key) ?? null),
		put: vi.fn(async (key, value) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key) => {
			store.delete(key);
		}),
	};
}

const SALT = 'sal-de-prueba';
const ADMIN_EMAIL = 'garantiasdyv@gmail.com';

async function makeEnv(password) {
	return {
		ADMIN_PASSWORD_SALT: SALT,
		ADMIN_PASSWORD_HASH: await hashPassword(password, SALT),
		ADMIN_EMAIL,
		RESEND_API_KEY: 'fake-resend-key',
		garantia_cache: makeKv(),
	};
}

function loginRequest(password) {
	return new Request('https://admin/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
}

function forgotRequest(email) {
	return new Request('https://garantia-worker.example/admin/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}

function resetRequest(token, password) {
	return new Request('https://admin/admin/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
}

function mockResendFetch() {
	return vi.fn(async (url) => {
		if (String(url).includes('api.resend.com')) return { ok: true, json: async () => ({ id: 'email-1' }) };
		throw new Error('URL de fetch inesperada en el test: ' + url);
	});
}

function cookieDe(response) {
	return response.headers.get('Set-Cookie');
}

function tokenDeCookie(cookie) {
	return cookie.match(/admin_session=([^;]*)/)?.[1];
}

function requestConCookie(cookie) {
	return new Request('https://admin/admin/api/files', { headers: { Cookie: `admin_session=${tokenDeCookie(cookie)}` } });
}

describe('hashPassword / compararEnTiempoConstante', () => {
	it('el mismo password y salt siempre dan el mismo hash', async () => {
		const a = await hashPassword('correcto-caballo-batería', 'sal1');
		const b = await hashPassword('correcto-caballo-batería', 'sal1');
		expect(a).toBe(b);
	});

	it('cambiar el salt cambia el hash aunque el password sea el mismo', async () => {
		const a = await hashPassword('mismo-password', 'sal1');
		const b = await hashPassword('mismo-password', 'sal2');
		expect(a).not.toBe(b);
	});

	it('compara igual solo si son idénticos', () => {
		expect(compararEnTiempoConstante('abcd', 'abcd')).toBe(true);
		expect(compararEnTiempoConstante('abcd', 'abce')).toBe(false);
	});

	it('longitudes distintas nunca dan igual', () => {
		expect(compararEnTiempoConstante('abc', 'abcd')).toBe(false);
	});
});

describe('manejarLogin', () => {
	it('password correcta setea cookie de sesión y responde ok', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const res = await manejarLogin(loginRequest('laClaveCorrecta'), env);

		expect(res.status).toBe(200);
		expect(cookieDe(res)).toMatch(/admin_session=.+; HttpOnly; Secure; SameSite=Strict; Path=\/admin/);
	});

	it('password incorrecta responde 401 sin cookie', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const res = await manejarLogin(loginRequest('otra-cosa'), env);

		expect(res.status).toBe(401);
		expect(cookieDe(res)).toBeNull();
	});

	it('la sesión creada al loguearse queda válida para requireAdminSession', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const login = await manejarLogin(loginRequest('laClaveCorrecta'), env);
		const cookie = cookieDe(login);

		const resultado = await requireAdminSession(requestConCookie(cookie), env);
		expect(resultado).toBeNull();
	});

	it('sin cookie, requireAdminSession devuelve 401', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const res = await requireAdminSession(new Request('https://admin/admin/api/files'), env);

		expect(res).not.toBeNull();
		expect(res.status).toBe(401);
	});

	it('un token que no existe en KV (vencido o inventado) también da 401', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const res = await requireAdminSession(requestConCookie('admin_session=token-inventado; HttpOnly'), env);

		expect(res.status).toBe(401);
	});

	it('tras 5 intentos fallidos, bloquea incluso con la password correcta', async () => {
		const env = await makeEnv('laClaveCorrecta');
		for (let i = 0; i < 5; i++) {
			const res = await manejarLogin(loginRequest('mal'), env);
			expect(res.status).toBe(401);
		}

		const bloqueado = await manejarLogin(loginRequest('laClaveCorrecta'), env);
		expect(bloqueado.status).toBe(429);
	});

	it('un login exitoso limpia el contador de intentos fallidos', async () => {
		const env = await makeEnv('laClaveCorrecta');
		await manejarLogin(loginRequest('mal'), env);
		await manejarLogin(loginRequest('mal'), env);

		const ok = await manejarLogin(loginRequest('laClaveCorrecta'), env);
		expect(ok.status).toBe(200);

		// Otro intento fallido después de un login ok no debería heredar el conteo previo.
		const otroMalo = await manejarLogin(loginRequest('mal'), env);
		expect(otroMalo.status).toBe(401);
		const bloqueadoTodavia = await env.garantia_cache.get('admin:login:fails');
		expect(Number(bloqueadoTodavia)).toBe(1);
	});
});

describe('manejarLogout', () => {
	it('borra la sesión: el token deja de ser válido', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const login = await manejarLogin(loginRequest('laClaveCorrecta'), env);
		const cookie = cookieDe(login);

		const logout = await manejarLogout(requestConCookie(cookie), env);
		expect(cookieDe(logout)).toMatch(/Max-Age=0/);

		const resultado = await requireAdminSession(requestConCookie(cookie), env);
		expect(resultado.status).toBe(401);
	});
});

describe('manejarForgotPassword', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('con el email correcto, manda el mail de reseteo', async () => {
		const fetchMock = mockResendFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = await makeEnv('laClaveCorrecta');

		const res = await manejarForgotPassword(forgotRequest(ADMIN_EMAIL), env);

		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, opciones] = fetchMock.mock.calls[0];
		expect(JSON.parse(opciones.body).to).toEqual([ADMIN_EMAIL]);
	});

	it('con un email que no es el del admin, responde igual pero no manda nada (sin oráculo)', async () => {
		const fetchMock = mockResendFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = await makeEnv('laClaveCorrecta');

		const conCorrecto = await manejarForgotPassword(forgotRequest(ADMIN_EMAIL), env);
		const conIncorrecto = await manejarForgotPassword(forgotRequest('otro@ejemplo.com'), env);

		expect(conCorrecto.status).toBe(conIncorrecto.status);
		expect(await conCorrecto.json()).toEqual(await conIncorrecto.json());
		expect(fetchMock).toHaveBeenCalledTimes(1); // solo por el email correcto
	});

	it('el token generado sirve para restablecer la contraseña', async () => {
		const fetchMock = mockResendFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = await makeEnv('laClaveVieja');

		await manejarForgotPassword(forgotRequest(ADMIN_EMAIL), env);
		const [, opciones] = fetchMock.mock.calls[0];
		const token = JSON.parse(opciones.body).html.match(/reset=([a-f0-9-]+)/)[1];

		const reset = await manejarResetPassword(resetRequest(token, 'unaClaveNuevaLarga'), env);
		expect(reset.status).toBe(200);

		const loginConVieja = await manejarLogin(loginRequest('laClaveVieja'), env);
		expect(loginConVieja.status).toBe(401);

		const loginConNueva = await manejarLogin(loginRequest('unaClaveNuevaLarga'), env);
		expect(loginConNueva.status).toBe(200);
	});

	it('después de 3 pedidos en la ventana, no manda más aunque el email sea correcto', async () => {
		const fetchMock = mockResendFetch();
		vi.stubGlobal('fetch', fetchMock);
		const env = await makeEnv('laClaveCorrecta');

		for (let i = 0; i < 3; i++) await manejarForgotPassword(forgotRequest(ADMIN_EMAIL), env);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		const cuarto = await manejarForgotPassword(forgotRequest(ADMIN_EMAIL), env);
		expect(cuarto.status).toBe(200); // misma respuesta genérica, no delata el límite
		expect(fetchMock).toHaveBeenCalledTimes(3); // no mandó un cuarto mail
	});
});

describe('manejarResetPassword', () => {
	it('rechaza un token inexistente o vencido', async () => {
		const env = await makeEnv('laClaveCorrecta');
		const res = await manejarResetPassword(resetRequest('token-inventado', 'unaClaveNuevaLarga'), env);
		expect(res.status).toBe(400);
	});

	it('rechaza una contraseña demasiado corta', async () => {
		const env = await makeEnv('laClaveCorrecta');
		await env.garantia_cache.put('admin:reset:tok1', '1');

		const res = await manejarResetPassword(resetRequest('tok1', 'corta'), env);
		expect(res.status).toBe(400);
	});

	it('el token es de un solo uso', async () => {
		const env = await makeEnv('laClaveCorrecta');
		await env.garantia_cache.put('admin:reset:tok1', '1');

		const primero = await manejarResetPassword(resetRequest('tok1', 'unaClaveNuevaLarga'), env);
		expect(primero.status).toBe(200);

		const segundo = await manejarResetPassword(resetRequest('tok1', 'otraClaveMasLarga'), env);
		expect(segundo.status).toBe(400);
	});
});
