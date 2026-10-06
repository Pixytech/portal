// Signed cookies. The HMAC key is derived from the GitHub App client secret,
// so there is no extra secret to manage; rotating the client secret signs
// everyone out.

const enc = new TextEncoder();
const dec = new TextDecoder();
let keyPromise;

function hmacKey(env) {
  if (!env.GITHUB_CLIENT_SECRET) throw new Error("GITHUB_CLIENT_SECRET is not set");
  keyPromise ??= crypto.subtle
    .importKey("raw", enc.encode(env.GITHUB_CLIENT_SECRET), "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("pixytech-portal"), info: enc.encode("cookie-v1") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      ),
    );
  return keyPromise;
}

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function seal(env, payload) {
  const data = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function unseal(env, value) {
  if (!value || !env.GITHUB_CLIENT_SECRET) return null;
  const [data, sig] = value.split(".");
  if (!data || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(sig), enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64url(data)));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function cookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
