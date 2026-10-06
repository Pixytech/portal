// Public tiles for everyone; signing in adds the private apps you're
// entitled to. The worker decides what each visitor sees.

const $ = (id) => document.getElementById(id);

async function getJson(url) {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function tileIcon(app) {
  const icon = app.icon || app.title.slice(0, 1).toUpperCase();
  if (/\.(svg|png|jpe?g|webp|gif)$/i.test(icon)) {
    const img = document.createElement("img");
    img.src = icon;
    img.alt = "";
    return img;
  }
  const span = document.createElement("span");
  span.textContent = icon;
  return span;
}

function renderTiles(apps) {
  const list = $("tiles");
  list.replaceChildren();
  for (const app of apps) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "tile";
    a.href = app.url;
    a.style.setProperty("--accent", app.color || "#6366f1");
    a.dataset.search = `${app.title} ${app.description || ""}`.toLowerCase();

    const icon = document.createElement("div");
    icon.className = "icon";
    icon.append(tileIcon(app));
    const title = document.createElement("h2");
    title.textContent = app.title;
    const desc = document.createElement("p");
    desc.textContent = app.description || "";
    a.append(icon, title, desc);

    if (app.private) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Team only";
      a.append(badge);
    }
    li.append(a);
    list.append(li);
  }
  $("empty").hidden = apps.length > 0;
}

async function main() {
  const here = location.pathname + location.search;
  $("signin").href = `/auth/login?return=${encodeURIComponent(here)}`;
  $("signout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    location.reload();
  });
  $("filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const tile of document.querySelectorAll(".tile")) {
      tile.parentElement.hidden = q !== "" && !tile.dataset.search.includes(q);
    }
  });

  const [session, apps, links] = await Promise.allSettled([
    getJson("/api/session"),
    getJson("/api/apps"),
    getJson("/links.json"),
  ]);

  const user = session.status === "fulfilled" ? session.value.user : null;
  $("signin").hidden = Boolean(user);
  $("user").hidden = !user;
  $("hint").hidden = Boolean(user);
  if (user) {
    $("avatar").src = user.avatar;
    $("login").textContent = user.login;
  }

  const all = [
    ...(apps.status === "fulfilled" ? apps.value.apps : []),
    ...(links.status === "fulfilled" ? links.value : []),
  ];
  all.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  $("error").hidden = apps.status === "fulfilled";
  renderTiles(all);
}

main();
