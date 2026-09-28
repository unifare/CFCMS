# CFPress v0.7.0

Cloudflare-native WordPress-style CMS built on Workers, D1, R2, KV and Static Assets.

## v0.7.0 implemented

- D1 role/permission matrix: admin, editor, author
- User management API + Admin Users screen
- Plugin declared settings schema + settings API/UI
- Safe declarative theme templates stored in R2 and rendered by a restricted template engine
- Theme ZIP extraction to R2 for templates/assets (uploaded JS is stored, not executed by the Worker)
- Scheduled publishing with Worker Cron every 5 minutes
- Search API for published content
- Admin Search screen
- Cache version invalidation when content changes
- Existing v0.6 ZIP extension installation, manifest validation, capabilities, revisions and autosave retained
- Multilingual routing, menus, SEO, sitemap, robots, R2 media and block editor retained

## Theme template syntax

Supported placeholders:

- `{{site.title}}`
- `{{site.locale}}`
- `{{page.title}}`
- `{{page.description}}`
- `{{content}}`
- `{{menu.primary}}`

Templates live in a theme package under `templates/index.html`, `templates/single.html`, `templates/page.html` and `templates/404.html`.

Uploaded extension JavaScript is **not executed in the main Worker**. This is intentional: packages are data plus declarative manifests/capabilities, avoiding arbitrary third-party code execution inside the CMS request process.

## Migrations

Apply migrations in order with Wrangler D1 migrations. v0.7 adds `migrations/0007_v070.sql`.

## Default admin

On first boot the Worker creates a single administrator account so you can log in:

- username: `admin`
- password: `change-me-now`

> **Change this password immediately.** It is a publicly known bootstrap default,
> not a secret. Any instance still using it is open to anyone who reads this file.

Authentication uses PBKDF2-hashed passwords (`src/core/crypto.ts`); the plaintext
is never stored. Sessions are signed cookies with a 14-day TTL.

## Development

```bash
npm install
npm run dev
```

## Deploy

Configure D1, R2 and KV IDs in `wrangler.jsonc`, then:

```bash
npm run db:migrate
npm run deploy
```
