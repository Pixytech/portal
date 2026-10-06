// GitHub API access as the GitHub App installation, not as the visitor.
// Visitors never get repository access; the worker reads on their behalf.

import { b64url } from "./session.js";

const API = "https://api.github.com";
const enc = new TextEncoder();
let signingKey;
let installation; // { id, token, expires }

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only
// imports PKCS#8, so wrap it in the PKCS#8 envelope.
function pkcs1ToPkcs8(pkcs1) {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...derLength(pkcs1.length), ...pkcs1];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

function appKey(env) {
  signingKey ??= (() => {
    const pem = env.GITHUB_APP_PRIVATE_KEY;
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
      c.charCodeAt(0),
    );
    const pkcs8 = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "sign",
    ]);
  })();
  return signingKey;
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await appKey(env), enc.encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

function headers(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "User-Agent": "pixytech-portal",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function installationToken(env) {
  if (installation && installation.expires - Date.now() > 5 * 60 * 1000) return installation.token;
  const jwt = await appJwt(env);
  let id = installation?.id;
  if (!id) {
    const res = await fetch(`${API}/app/installations`, { headers: headers(jwt) });
    if (!res.ok) throw new Error(`GitHub App installations: ${res.status}`);
    const owner = env.OWNER.toLowerCase();
    const found = (await res.json()).find((i) => i.account?.login?.toLowerCase() === owner);
    if (!found) throw new Error(`GitHub App is not installed on ${env.OWNER}`);
    id = found.id;
  }
  const res = await fetch(`${API}/app/installations/${id}/access_tokens`, { method: "POST", headers: headers(jwt) });
  if (!res.ok) throw new Error(`GitHub App token: ${res.status}`);
  const body = await res.json();
  installation = { id, token: body.token, expires: Date.parse(body.expires_at) };
  return installation.token;
}

export function appConfigured(env) {
  const set = (v) => Boolean(v) && !String(v).startsWith("REPLACE_");
  return set(env.GITHUB_APP_ID) && set(env.GITHUB_CLIENT_ID) && set(env.GITHUB_APP_PRIVATE_KEY) && set(env.GITHUB_CLIENT_SECRET);
}

// JSON from the GitHub API as the installation.
export async function api(env, path) {
  const res = await fetch(`${API}${path}`, { headers: headers(await installationToken(env)) });
  if (!res.ok) {
    const err = new Error(`GitHub ${path}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Raw file contents (up to 100 MB) as a streaming Response.
export async function rawFile(env, repo, path, ref) {
  const url = `${API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
  return fetch(url, { headers: headers(await installationToken(env), "application/vnd.github.raw") });
}

export async function rawJson(env, repo, path, ref) {
  const res = await rawFile(env, repo, path, ref);
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Sign-in: swap the OAuth code for a user token, read who they are, and
// throw the token away.
export async function identify(env, code, redirectUri) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "pixytech-portal" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || data.error || "Sign-in failed");
  const user = await fetch(`${API}/user`, { headers: headers(data.access_token) });
  if (!user.ok) throw new Error(`Could not read your GitHub profile (${user.status})`);
  const u = await user.json();
  return { login: u.login, id: u.id, avatar: u.avatar_url };
}
