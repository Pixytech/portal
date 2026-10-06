# Pixytech Portal

A tile launcher for Pixytech apps at
<https://portal.pixytech.com/>.

Anyone can open it and see the public apps. Signing in with GitHub shows the
private apps you've been given access to. Getting access to an app never
gives you access to its source code.

```
site/                 the portal page (static files)
worker/               Cloudflare Worker: sign-in, app list, private-app proxy
  src/index.js        routes
  src/apps.js         app catalog, access rules, file proxy
  src/github.js       GitHub App auth
  src/session.js      signed cookies
redirect/             what pixytech.github.io/portal/ serves: a redirect here
```

## How it works

**Apps are repos.** Any repo the GitHub App is installed on that has a
`portal.json` on its default branch becomes a tile:

```json
{
  "title": "PX",
  "description": "What it is, in one line.",
  "icon": "PX",
  "color": "#7c3aed",
  "order": 10,
  "access": "private"
}
```

- `"access": "public"` tiles link to `url` (or the repo's homepage). The app
  hosts itself, usually on its own GitHub Pages. Everyone sees these.
- `"access": "private"` apps are served by the worker at `/apps/<slug>/` from
  the repo's `site` branch (change with `"branch"`). The slug is the repo name
  in lower case unless `"slug"` says otherwise. Build the app with base path
  `/apps/<slug>/` and push the build output to that branch.

**Access is GitHub org teams.** Pixytech is a GitHub organization, and each
private app has a team:

- `app-<slug>` (e.g. `app-px`) can use that app. Name other teams in
  portal.json with `"teams": ["beta-testers"]` if you'd rather.
- `portal-admins` can use every private app.

To give someone PX, add their GitHub account to the `app-px` team. To take it
away, remove them. Changes apply within a minute. Give these teams **no
repository access**: being in `app-px` should not mean seeing px's code.
Team members do have to be members of the org.

**The worker does the reading.** It reads repos as the GitHub App
installation (Contents: read-only), checks the visitor's signed session cookie
and team membership on every request, and streams the file. Visitors only
ever get built files, never the repo. Files are cached at the edge by commit,
and responses are marked `private` so no shared cache keeps them.

Sign-in uses the same GitHub App. The visitor's GitHub token is used once to
read their login and then thrown away.

## Adding an app

Public: add a `portal.json` with `"access": "public"` and its `url`, then
add the repo to the GitHub App's installation.

Private: same, with `"access": "private"`, plus a workflow that builds with
base `/apps/<slug>/` and force-pushes the output to a `site` branch (see
`Pixytech/px` `.github/workflows/publish-site.yml`). Then create its `app-<slug>` team
and add people. The tile shows up within five minutes.

## One-time setup

1. **Create a GitHub App**:
   - Homepage URL: `https://portal.pixytech.com/`
   - Create it under the organization (org Settings → Developer settings →
     GitHub Apps).
   - Callback URL: `https://portal.pixytech.com/auth/callback`
   - Webhook: untick Active.
   - Repository permissions: **Contents: Read-only** (Metadata: Read-only is
     added automatically).
   - Organization permissions: **Members: Read-only**.
   - Where can it be installed: Only on this account.
   - After creating: note the App ID and Client ID, generate a client secret
     and a private key (.pem download).
2. **Install the app** on the org, choosing "Only select repositories" and
   picking the app repos (px, LiveLens, ...).
3. **Configure the worker**: put the App ID and Client ID in
   `worker/wrangler.toml`, then from `worker/`:
   ```sh
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < path/to/key.pem
   npx wrangler deploy
   ```
4. **Create the teams** under the org's Teams tab: `portal-admins` and one
   `app-<slug>` per private app, all with no repository access.

Optional: add repo secret `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare
Workers") and repo variable `CLOUDFLARE_ACCOUNT_ID` so pushes to `main`
deploy automatically.

## Local preview

```sh
cd worker
npx wrangler dev
```

Put test values in `worker/.dev.vars` (git-ignored) to try sign-in locally;
the GitHub App needs `http://localhost:8787/auth/callback` as an extra
callback URL for that.
