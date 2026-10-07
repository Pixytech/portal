// App catalog, entitlements and the private-app file proxy.
//
// An app is any repo the GitHub App is installed on that has a portal.json
// on its default branch; installing the app on a repo is the on switch. Public apps link to wherever they are
// hosted. Private apps are served from a branch of their own repo (default
// "site") at /apps/<slug>/, only to members of the app's org teams.

import { api, rawFile, rawJson } from "./github.js";

const CATALOG_TTL = 5 * 60 * 1000;
const MEMBERSHIP_TTL = 60 * 1000;
const BRANCH_TTL = 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

let catalog; // { at, apps }
const branches = new Map(); // "repo@branch" -> { at, sha }
const memberships = new Map(); // "team:login" -> { at, ok }

async function listRepos(env) {
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const body = await api(env, `/installation/repositories?per_page=100&page=${page}`);
    repos.push(...body.repositories);
    if (repos.length >= body.total_count || body.repositories.length === 0) break;
  }
  return repos;
}

async function buildCatalog(env) {
  const owner = env.OWNER.toLowerCase();
  const repos = (await listRepos(env)).filter(
    (r) => r.owner.login.toLowerCase() === owner && !r.archived,
  );
  const apps = await Promise.all(
    repos.map(async (repo) => {
      const meta = await rawJson(env, repo.full_name, "portal.json", repo.default_branch);
      if (!meta) return null;
      const slug = String(meta.slug || repo.name).toLowerCase();
      if (!SLUG.test(slug)) return null;
      const isPrivate = (meta.access || (repo.private ? "private" : "public")) === "private";
      const url = isPrivate ? `/apps/${slug}/` : meta.url || repo.homepage || repo.html_url;
      let icon = meta.icon || "";
      if (/\.(svg|png|jpe?g|webp|gif)$/i.test(icon) && !/^https?:/i.test(icon)) {
        icon = new URL(icon, new URL(url, "https://x.invalid")).href.replace("https://x.invalid", "");
      }
      return {
        slug,
        title: meta.title || repo.name,
        description: meta.description || repo.description || "",
        icon,
        color: meta.color,
        order: meta.order ?? 100,
        url,
        private: isPrivate,
        repo: repo.full_name,
        branch: meta.branch || "site",
        teams: Array.isArray(meta.teams) && meta.teams.length ? meta.teams.map(String) : [`app-${slug}`],
      };
    }),
  );
  const bySlug = new Map();
  for (const app of apps) if (app && !bySlug.has(app.slug)) bySlug.set(app.slug, app);
  return [...bySlug.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export async function getCatalog(env) {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.apps;
  try {
    catalog = { at: Date.now(), apps: await buildCatalog(env) };
  } catch (e) {
    if (!catalog) throw e;
    // Keep serving the last good list if GitHub hiccups.
  }
  return catalog.apps;
}

// Org team membership, read as the installation (needs Members: read).
async function inTeam(env, team, login) {
  const key = `${team}:${login}`.toLowerCase();
  const hit = memberships.get(key);
  if (hit && Date.now() - hit.at < MEMBERSHIP_TTL) return hit.ok;
  let ok = false;
  try {
    const m = await api(
      env,
      `/orgs/${env.OWNER}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`,
    );
    ok = m.state === "active";
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  memberships.set(key, { at: Date.now(), ok });
  return ok;
}

// Members of ADMIN_TEAM get every app. Everyone else needs to be in one of
// the app's teams: portal.json "teams", or app-<slug> when it names none.
export async function canUse(env, login, slug) {
  if (!login) return false;
  const app = (await getCatalog(env)).find((a) => a.slug === slug);
  if (!app) return false;
  if (env.ADMIN_TEAM && (await inTeam(env, env.ADMIN_TEAM, login))) return true;
  for (const team of app.teams) if (await inTeam(env, team, login)) return true;
  return false;
}

export async function visibleApps(env, login) {
  const apps = await getCatalog(env);
  const out = [];
  for (const app of apps) {
    if (app.private && !(await canUse(env, login, app.slug))) continue;
    const { repo, branch, teams, ...pub } = app;
    out.push(pub);
  }
  return out;
}

async function branchSha(env, repo, branch) {
  const key = `${repo}@${branch}`;
  const hit = branches.get(key);
  if (hit && Date.now() - hit.at < BRANCH_TTL) return hit.sha;
  const body = await api(env, `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  branches.set(key, { at: Date.now(), sha: body.commit.sha });
  return body.commit.sha;
}

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
  onnx: "application/octet-stream",
  bin: "application/octet-stream",
};

function extension(path) {
  const last = path.split("/").pop();
  const i = last.lastIndexOf(".");
  return i > 0 ? last.slice(i + 1).toLowerCase() : "";
}

// Serves /apps/<slug>/<path> from the app's branch. The caller has already
// checked the visitor may use the app.
export async function serveFile(env, ctx, app, path) {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s === ".")) return new Response("Bad path", { status: 400 });
  let file = segments.join("/");
  if (file === "" || path.endsWith("/")) file = file ? `${file}/index.html` : "index.html";

  const sha = await branchSha(env, app.repo, app.branch);
  const cache = caches.default;

  const fetchCached = async (p) => {
    // Never reachable from outside: the host does not exist, and entries are
    // only read after the access check above.
    const key = new Request(`https://portal-cache.invalid/${app.repo}/${sha}/${p}`);
    let res = await cache.match(key);
    if (res) return res;
    res = await rawFile(env, app.repo, p, sha);
    if (!res.ok) return res;
    const stored = new Response(res.body, { headers: { "Cache-Control": "max-age=86400" } });
    ctx.waitUntil(cache.put(key, stored.clone()));
    return stored;
  };

  let res = await fetchCached(file);
  // Single-page apps: unknown routes without a file extension get index.html.
  if (res.status === 404 && !extension(file)) {
    file = "index.html";
    res = await fetchCached(file);
  }
  if (!res.ok) return new Response("Not found", { status: res.status === 404 ? 404 : 502 });

  const ext = extension(file);
  return new Response(res.body, {
    headers: {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      // private: browsers may cache, shared caches and CDNs may not.
      "Cache-Control": ext === "html" ? "private, no-cache" : "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
