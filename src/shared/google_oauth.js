// Canje de refresh token por access token de Google OAuth — portable a
// Node (CLI) y a Workers (panel admin). Sin imports de Node: solo fetch.
//
// El flujo interactivo para OBTENER el refresh token (src/google_auth.js)
// no vive acá a propósito: usa `http`/`child_process`, que no corren en
// workerd. Esta función es la única parte de ese archivo que hace falta
// una vez que el refresh token ya existe.

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: 'refresh_token',
		}),
	});
	const data = await res.json();
	if (!data.access_token) throw new Error('No se pudo renovar el access token: ' + JSON.stringify(data));
	return data.access_token;
}
