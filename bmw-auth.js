import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, "secret.cfg");
const TOKEN_FILE = path.join(__dirname, "bmw_tokens.json");

// BMW GCDM OAuth2 Endpunkte (CarData Device Flow)
const DEVICE_CODE_URL = "https://customer.bmwgroup.com/gcdm/oauth/device/code";
const TOKEN_URL = "https://customer.bmwgroup.com/gcdm/oauth/token";
const SCOPES = "authenticate_user openid cardata:api:read cardata:streaming:read";

// 1. Konfiguration aus secret.cfg laden
export function loadConfig() {
  if (!fs.existsSync(SECRET_FILE)) {
    throw new Error(`Konfigurationsdatei fehlt: ${SECRET_FILE}`);
  }
  const config = {};
  const lines = fs.readFileSync(SECRET_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    config[key.trim()] = rest.join("=").trim();
  }
  if (!config.CLIENT_ID) {
    throw new Error("CLIENT_ID fehlt in secret.cfg");
  }
  return config;
}

// 2. PKCE Code Verifier & Challenge erzeugen (für BMW Device Flow erforderlich)
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// 3. Tokens lokal speichern & laden
function saveTokens(tokenResponse) {
  const payload = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    token_type: tokenResponse.token_type || "Bearer",
    expires_in: tokenResponse.expires_in,
    expires_at: Date.now() + (tokenResponse.expires_in - 60) * 1000, // 60s Puffer
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

// 4. Token-Refresh über vorhandenes refresh_token
async function refreshAccessToken(clientId, refreshToken) {
  console.log("[AUTH] Erneuere Access-Token über Refresh-Token...");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Refresh fehlgeschlagen (${res.status}): ${JSON.stringify(data)}`);
  }

  const saved = saveTokens(data);
  console.log("[AUTH] Neues Access-Token erfolgreich gespeichert.");
  return saved;
}

// 5. Initialer OAuth2 Device Code Flow
async function runDeviceCodeFlow(clientId) {
  const { verifier, challenge } = generatePKCE();

  const initBody = new URLSearchParams({
    client_id: clientId,
    response_type: "device_code",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  const initRes = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: initBody
  });

  const deviceData = await initRes.json();
  if (!initRes.ok) {
    throw new Error(`Device-Flow Start fehlgeschlagen (${initRes.status}): ${JSON.stringify(deviceData)}`);
  }

  const verifyUrl = deviceData.verification_uri_complete || deviceData.verification_uri;
  console.log("\n========================================================");
  console.log("1. Öffne folgende URL im Browser und melde dich bei BMW an:");
  console.log(`   ${verifyUrl}`);
  if (deviceData.user_code) {
    console.log(`2. Falls abgefragt, gib diesen Code ein: ${deviceData.user_code}`);
  }
  console.log("========================================================\n");

  const intervalMs = (deviceData.interval || 5) * 1000;
  const expiresAt = Date.now() + (deviceData.expires_in || 600) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, intervalMs));
    process.stdout.write(".");

    const pollBody = new URLSearchParams({
      client_id: clientId,
      device_code: deviceData.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      code_verifier: verifier
    });

    const pollRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pollBody
    });

    const pollData = await pollRes.json();

    if (pollRes.ok && pollData.access_token) {
      console.log("\n[AUTH] Authentifizierung erfolgreich!");
      return saveTokens(pollData);
    }

    if (pollData.error === "authorization_pending" || pollData.error === "slow_down") {
      continue;
    }

    throw new Error(`\n[AUTH] Abbruch durch Server: ${JSON.stringify(pollData)}`);
  }

  throw new Error("\n[AUTH] Zeitüberschreitung beim Warten auf Browser-Freigabe.");
}

// 6. Hauptfunktion: Liefert immer ein gültiges Access-Token zurück
export async function getValidToken() {
  const config = loadConfig();
  let tokens = loadTokens();

  if (tokens && tokens.access_token && Date.now() < tokens.expires_at) {
    console.log("[AUTH] Vorhandenes Access-Token ist noch gültig.");
    return tokens;
  }

  if (tokens && tokens.refresh_token) {
    try {
      return await refreshAccessToken(config.CLIENT_ID, tokens.refresh_token);
    } catch (err) {
      console.warn(`[WARN] Refresh-Token ungültig oder abgelaufen (${err.message}). Starte neuen Login...`);
    }
  }

  return await runDeviceCodeFlow(config.CLIENT_ID);
}

// Direkter Aufruf über CLI: node bmw-auth.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  getValidToken()
    .then((tokens) => {
      console.log("\nAktuelles Access-Token (gekürzt):", tokens.access_token.slice(0, 35) + "...");
      console.log("Refresh-Token (gekürzt):         ", tokens.refresh_token.slice(0, 25) + "...");
      console.log("Gültig bis:                      ", new Date(tokens.expires_at).toLocaleString("de-DE"));
      console.log(`Vollständige Tokens gespeichert in: ${TOKEN_FILE}`);
    })
    .catch((err) => {
      console.error("\n[FEHLER]", err.message);
      process.exit(1);
    });
}