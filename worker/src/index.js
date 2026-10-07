// Pixytech portal: serves the portal page (site/), GitHub sign-in, the app
// list, and private apps out of their own repos.
//
//   /auth/login?return=/path   start GitHub sign-in
//   /auth/callback             GitHub redirects here
//   /auth/logout   (POST)      clear the session
//   /api/session               { user } or { user: null }
//   /api/apps                  apps this visitor can see
//   /apps/<slug>/...           private app files, signed-in and entitled only
//   everything else            static files from site/
//
// Settings: see wrangler.toml [vars]; secrets GITHUB_CLIENT_SECRET and
// GITHUB_APP_PRIVATE_KEY are set with `wrangler secret put`.

import { seal, unseal, readCookie, cookie, b64url } from "./session.js";
import { appConfigured, identify } from "./github.js";
import { getCatalog, canUse, visibleApps, serveFile } from "./apps.js";

const SESSION = "__Host-portal-session";
const OAUTH = "__Host-portal-oauth";
const SESSION_HOURS = 8;
const INSTALL_FILES = /^(manifest\.webmanifest|pwa-[a-z0-9-]+\.png|favicon\.png)$/;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

// Only same-site paths; never "//host" or "/\host".
function safeReturn(value) {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/";
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function page(status, title, message) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css">
<main class="center"><div class="card"><h1>${esc(title)}</h1><p>${message}</p>
<p><a class="button ghost" href="/">Back to the portal</a></p></div></main></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

async function login(env, url) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const ret = safeReturn(url.searchParams.get("return"));
  const sealed = await seal(env, { state, ret, exp: Date.now() + 10 * 60 * 1000 });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    state,
    allow_signup: "false",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: gh.href, "Set-Cookie": cookie(OAUTH, sealed, 600), "Cache-Control": "no-store" },
  });
}

async function callback(request, env, url) {
  const pending = await unseal(env, readCookie(request, OAUTH));
  if (url.searchParams.get("error")) {
    return page(400, "Sign-in cancelled", "GitHub did not complete the sign-in.");
  }
  if (!pending || pending.state !== url.searchParams.get("state")) {
    return page(400, "Sign-in expired", "The sign-in took too long or started in another tab. Try again.");
  }
  let user;
  try {
    user = await identify(env, url.searchParams.get("code"), `${url.origin}/auth/callback`);
  } catch (e) {
    console.error(e);
    return page(502, "Sign-in failed", "GitHub would not confirm the sign-in. Try again in a minute.");
  }
  const session = await seal(env, { ...user, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  const headers = new Headers({ Location: pending.ret, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(OAUTH, "", 0));
  headers.append("Set-Cookie", cookie(SESSION, session, SESSION_HOURS * 3600));
  return new Response(null, { status: 302, headers });
}

async function privateApp(request, env, ctx, url, user) {
  const [, , slug, ...rest] = url.pathname.split("/");
  if (!slug) return Response.redirect(`${url.origin}/`, 302);
  // Apps are built with base /apps/<slug>/, so the trailing slash matters.
  if (rest.length === 0) return Response.redirect(`${url.origin}/apps/${slug}/${url.search}`, 301);

  const app = (await getCatalog(env)).find((a) => a.slug === slug && a.private);
  if (!app) return page(404, "Not found", "There is no app at this address.");
  // The install manifest and its icons: browsers fetch the icons without cookies, and they give nothing away.
  const file = rest.join("/");
  if (INSTALL_FILES.test(file)) return serveFile(env, ctx, app, file);
  if (!user) {
    const wantsPage = (request.headers.get("Accept") || "").includes("text/html");
    if (!wantsPage) return new Response("Sign in required", { status: 401 });
    const ret = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/auth/login?return=${ret}`, 302);
  }
  if (!(await canUse(env, user.login, slug))) {
    return page(
      403,
      "No access",
      `You're signed in as <strong>${esc(user.login)}</strong>, but you're not on the list for this app. Ask the owner to add you.`,
    );
  }
  return serveFile(env, ctx, app, decodeURIComponent(rest.join("/")));
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  // One address for everyone: sessions and the GitHub callback live there.
  // Plain http would also break sign-in: GitHub only knows the https
  // callback, and the __Host- cookies need a secure page.
  const wrongHost = env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST && url.hostname.endsWith(".workers.dev");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (wrongHost || (url.protocol === "http:" && !local)) {
    if (wrongHost) url.hostname = env.CANONICAL_HOST;
    url.protocol = "https:";
    return Response.redirect(url.href, 301);
  }
  const path = url.pathname;
  const user = await unseal(env, readCookie(request, SESSION));

  try {
    if (path.startsWith("/auth/") && !appConfigured(env)) {
      return page(503, "Not set up yet", "Sign-in isn't configured on this portal yet.");
    }
    if (path === "/auth/login") return await login(env, url);
    if (path === "/auth/callback") return await callback(request, env, url);
    if (path === "/auth/logout") {
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
      return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION, "", 0) });
    }
    if (path === "/api/session") {
      return json({ user: user ? { login: user.login, avatar: user.avatar } : null });
    }
    if (path === "/api/apps") {
      if (!appConfigured(env)) return json({ apps: [], warning: "GitHub App not configured" });
      return json({ apps: await visibleApps(env, user?.login) });
    }
    if (path === "/apps" || path.startsWith("/apps/")) {
      if (!appConfigured(env)) return page(503, "Not set up yet", "Private apps are not configured.");
      return await privateApp(request, env, ctx, url, user);
    }
  } catch (e) {
    console.error(e);
    return path.startsWith("/api/")
      ? json({ error: "upstream_error" }, 502)
      : page(502, "Something went wrong", "GitHub didn't answer as expected. Try again in a minute.");
  }

  return env.ASSETS.fetch(request);
}

// Tell browsers to skip http entirely from now on (6 months). Only sent over
// https; browsers ignore it on http anyway.
const HSTS = "max-age=15552000; includeSubDomains";

export default {
  async fetch(request, env, ctx) {
    const res = await handle(request, env, ctx);
    if (new URL(request.url).protocol !== "https:") return res;
    const out = new Response(res.body, res);
    out.headers.set("Strict-Transport-Security", HSTS);
    return out;
  },
};
