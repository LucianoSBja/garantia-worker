// Envío de mails transaccionales — GarantIA, recuperación de contraseña.
//
// Resend en vez de SMTP: API vía fetch, sin librerías, mismo estilo que el
// resto del proyecto. El remitente usa el dominio de pruebas de Resend
// (onboarding@resend.dev) — funciona sin verificar un dominio propio, con
// el límite de que Resend puede marcarlo como menos confiable que un
// dominio verificado. Si hace falta más adelante, verificar un dominio
// propio en el dashboard de Resend y cambiar FROM acá, nada más.

const RESEND_API = 'https://api.resend.com/emails';
const FROM = 'GarantIA <onboarding@resend.dev>';

export async function enviarEmail(env, { to, subject, html }) {
	const res = await fetch(RESEND_API, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ from: FROM, to: [to], subject, html }),
	});

	if (!res.ok) {
		throw new Error(`Resend respondió ${res.status}: ${await res.text()}`);
	}
	return res.json();
}
