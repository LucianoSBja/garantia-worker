// Autorización OAuth de Google Drive — GarantIA
// Se corre UNA sola vez para obtener el refresh token que después usa la ingesta.
//
// Uso:
//   node src/google_auth.js           autoriza y muestra el refresh token
//   node src/google_auth.js --verify  chequea que el refresh token guardado sirva

import { createServer } from "http";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// El redirect_uri tiene que coincidir exacto con el registrado en el cliente
// OAuth de la consola de Google. Si el cliente es de tipo Aplicación web, hay
// que darlo de alta ahí a mano; los de escritorio aceptan loopback solos.
const PORT         = Number(process.env.GOOGLE_OAUTH_PORT) || 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;

// drive.file es el scope mínimo: solo da acceso a los archivos que crea esta
// app, no a todo el Drive de la cuenta.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

const AUTH_ENDPOINT  = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// ── Intercambio de tokens ─────────────────────────────────────────────────────

async function exchangeCode(code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Error canjeando el código: " + JSON.stringify(data));
  return data;
}

// Exportada porque la ingesta va a necesitar lo mismo para renovar el access token.
export async function getAccessToken(refreshToken = REFRESH_TOKEN) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("No se pudo renovar el access token: " + JSON.stringify(data));
  return data.access_token;
}

// ── Flujo interactivo ─────────────────────────────────────────────────────────

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         SCOPE,
    state,
    // Sin estos dos Google no devuelve refresh token: access_type=offline lo
    // habilita, y prompt=consent fuerza que lo mande de nuevo aunque la cuenta
    // ya haya autorizado antes.
    access_type:   "offline",
    prompt:        "consent",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);

      // El navegador también pide /favicon.ico sobre la misma conexión; si ya
      // resolvimos, lo ignoramos en vez de tratarlo como una respuesta fallida.
      if (settled) {
        res.writeHead(204);
        res.end();
        return;
      }

      const code  = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      // El state tiene que volver igual que como lo mandamos: si no coincide,
      // la respuesta no vino del flujo que iniciamos nosotros.
      const stateOk = state === expectedState;
      const ok = Boolean(code) && stateOk;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<h2>Listo. Ya podés cerrar esta pestaña y volver a la terminal.</h2>"
          : `<h2>Falló la autorización: ${error || (code ? "state inválido" : "sin código")}</h2>`
      );

      settled = true;
      server.close();

      if (ok) resolve(code);
      else if (!stateOk && code) reject(new Error("El state no coincide; se aborta por seguridad."));
      else reject(new Error(error || "Google no devolvió el código"));
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`El puerto ${PORT} está ocupado. Cerrá lo que lo esté usando y reintentá.`));
      } else {
        reject(err);
      }
    });

    server.listen(PORT);
  });
}

function openBrowser(url) {
  // Si no está xdg-open no importa: igual imprimimos la URL para abrirla a mano.
  // El fallo llega como evento 'error', no como excepción, así que un try/catch
  // acá no alcanzaría y el proceso se caería.
  const child = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function authorize() {
  const state = randomUUID();
  const url = buildAuthUrl(state);

  console.log("\n🔑 Abriendo el navegador para autorizar el acceso a Drive.");
  console.log("   Si no se abre solo, pegá esta URL:\n");
  console.log(`   ${url}\n`);
  console.log(`   Esperando la respuesta en ${REDIRECT_URI} ...\n`);

  openBrowser(url);
  const code = await waitForCode(state);
  const tokens = await exchangeCode(code);

  if (!tokens.refresh_token) {
    console.error("❌ Google no devolvió refresh_token.");
    console.error("   Suele pasar si la cuenta ya autorizó antes. Revocá el acceso en");
    console.error("   https://myaccount.google.com/permissions y volvé a correr esto.");
    process.exit(1);
  }

  console.log("✅ Autorización completa.\n");
  console.log("Agregá esta línea al .env:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log("⚠️  Si la app quedó en estado 'Testing' en la consola de Google, este token");
  console.log("   vence a los 7 días. Publicala en 'In Production' para que no caduque.\n");
}

// ── Verificación ──────────────────────────────────────────────────────────────

async function verify() {
  if (!REFRESH_TOKEN) {
    console.error("❌ Falta GOOGLE_REFRESH_TOKEN en el .env. Corré el script sin --verify primero.");
    process.exit(1);
  }

  const accessToken = await getAccessToken();
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user,storageQuota", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();

  if (!res.ok) {
    console.error("❌ El token no sirve:", JSON.stringify(data));
    process.exit(1);
  }

  const usado = Number(data.storageQuota?.usage || 0) / 1073741824;
  // limit viene vacío en cuentas con almacenamiento ilimitado.
  const limit = data.storageQuota?.limit;
  const total = limit ? `${(Number(limit) / 1073741824).toFixed(0)} GB` : "ilimitado";

  console.log("\n✅ Token válido.");
  console.log(`   Cuenta: ${data.user?.emailAddress}`);
  console.log(`   Drive:  ${usado.toFixed(2)} GB usados de ${total}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Faltan GOOGLE_OAUTH_CLIENT_ID y/o GOOGLE_OAUTH_CLIENT_SECRET en el .env");
    process.exit(1);
  }

  if (process.argv.includes("--verify")) await verify();
  else await authorize();
}

// Solo arranca el flujo si se invoca el archivo directamente: drive_upload.js
// importa getAccessToken y no tiene que quedarse esperando una autorización.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("❌", err.message);
    process.exit(1);
  });
}
