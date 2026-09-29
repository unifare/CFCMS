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

## Launcher (start / deploy)

`scripts/cfpress.sh` (POSIX sh) and `scripts/cfpress.ps1` (Windows PowerShell)
wrap the commands above into one entry point. Both offer the same actions with
the same numbers and the same exit codes — a parity suite
(`tests/launcher-parity.test.mjs`) fails if they drift apart.

**Numeric menu** — run with no arguments and pick a number:

```
 1) 启动本地服务   dev (port 8787)      6) 租户/语言审计   audit
 2) 本地数据库迁移  migrate --local      7) 部署            deploy
 3) 部署主题        theme deploy        8) 部署+远程迁移   deploy:full
 4) 跑全部测试      test (per suite)    9) 诊断环境        doctor
 5) 类型检查        tsc --noEmit
```

```bash
sh scripts/cfpress.sh            # Linux / macOS / Git Bash
.\scripts\cfpress.ps1            # Windows PowerShell
```

**Command mode** — pass an action to skip the menu, for CI and scripting:

```bash
sh scripts/cfpress.sh dev                  # start the local dev server
sh scripts/cfpress.sh migrate:local        # apply migrations locally
sh scripts/cfpress.sh theme themes/eshop   # upload + activate a theme
sh scripts/cfpress.sh test                 # run every suite, one process each
sh scripts/cfpress.sh test multisite       # run one suite
sh scripts/cfpress.sh typecheck            # tsc --noEmit
sh scripts/cfpress.sh doctor               # environment report
sh scripts/cfpress.sh help                 # all actions
```

Two things the launcher does that `npm test` and `npm run deploy` do not:

- **Tests run one suite per process.** `npm test` is a single `&&` chain, which
  in a locked-down sandbox reports every suite as `SKIP` and is easy to misread.
  The launcher runs each suite itself, parses that suite's own summary line, and
  counts a run with **no** summary as a failure.
- **`deploy` refuses to run while `wrangler.jsonc` still holds
  `REPLACE_WITH_...` placeholders.** Deploying with those in place does not fail
  loudly — it produces a Worker whose DB binding points nowhere. The launcher
  prints the `wrangler d1 create` / `wrangler kv namespace create` commands to
  run instead. Pass `--force` to override.

## Deploy

Configure D1, R2 and KV IDs in `wrangler.jsonc` (the launcher's `doctor` action
tells you whether this is still pending), then:

```bash
npm run db:migrate
npm run deploy
```

or, in one step, `sh scripts/cfpress.sh deploy:full` (remote migrations, then
deploy).

## License

CFCMS is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).
See [LICENSE](LICENSE) for the full text.

In short: you are free to use, study, modify and redistribute this software.
The AGPL adds one obligation over the plain GPL — if you run a modified version
as a network service (a hosted CMS, a SaaS offering), you must offer the
corresponding source code to the users of that service. Running it unmodified
as your own site carries no such obligation beyond keeping the notices intact.
