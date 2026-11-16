# xFactura

Romanian invoicing and accounting in the existing web/API applications. The public invoicer keeps its browser-local company, invoice and inventory data. Accounting at `/contabilitate` uses authenticated, company-scoped server persistence: local SQLite by default, with an optional Turso connection.

See the [documentation index](docs/README.md) for current accounting coverage, the full build backlog and the product feature vision.

## Run locally

Use Bun 1.4.2 and Node.js 24 or later. Run commands from this directory.

```sh
bun install --frozen-lockfile
bun run setup
bun run db:migrate
```

`setup` creates private local configuration and generates an authentication secret. It preserves existing nonempty values except an authentication secret beginning with `replace-with-`. Configure an account through the operator CLI with a password of at least 12 characters; public registration is disabled:

```sh
read -r -s ACCOUNT_PASSWORD
export ACCOUNT_PASSWORD
ACCOUNT_EMAIL=you@example.com ACCOUNT_NAME='Your name' bun run account:create
unset ACCOUNT_PASSWORD
bun run dev
```

Open [localhost:3000/contabilitate](http://localhost:3000/contabilitate). `dev` starts the web application, the existing API on port 8089 and the export worker. Accounting requires no Piatra, Google, Stripe or AI key. Existing provider integrations remain optional.

## Accounting coverage

Accounting runs on one append-only kernel: documents and evidence feed pure treatments, every effect is approved by a person for its exact hash (or posted under a human-approved policy), and the database itself refuses unapproved, unbalanced or altered entries.

See [IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for what exists today and [ROADMAP.md](docs/ROADMAP.md) for what remains.

The public invoicer retains its own browser-local data and JSON/PDF/XML workflows. Importing an invoice does not establish ANAF acceptance, and a VAT journal or a closed month is not a declaration.

## SQLite and Turso

Configure `.env` using [.env.example](.env.example). Local data is stored in `.accounting/xfactura.db`; immutable originals and generated exports are stored in `.accounting/objects`.

For Turso, set `DATABASE_URL` to the libSQL database URL and `DATABASE_AUTH_TOKEN` to its scoped token, then run the same migration and account commands through the existing libSQL adapter. Keep document storage persistent and shared between API and worker. The automated integration/recovery suite exercises local SQLite; remote Turso behavior and provider recovery need verification on the target deployment.

## Schema changes

The accounting schema lives in [schema.ts](packages/xfactura-api/source/engine/db/schema.ts). Generate a migration after changing it, review the SQL, and apply it:

```sh
bun run db:generate --name=describe_the_change
bun run db:migrate
```

Database invariants are not migrations. They are declared, with a plain-language rule for each, in [invariants.ts](packages/xfactura-api/source/engine/db/invariants.ts) and installed by `db:migrate` after the generated migrations; a changed invariant is replaced and a removed one dropped. The invariant test suite fails if any guard is missing or ineffective. Applied migrations are never edited.

The kernel started from a new baseline on 29 October 2026 ([ADR 0012](docs/adr/0012-baseline-reset-and-oracles.md)). `db:migrate` refuses a database created by the previous engine: move `.accounting/` aside and migrate a new one.

## Docker Compose

Use the same root build context and configuration:

```sh
bun run setup
docker compose up --build -d
```

Compose runs web, API and worker with one persistent `accounting-data` volume. It applies migrations before starting the API. The web application binds to `127.0.0.1:3000`; API and worker are internal. To create an account in that deployment:

```sh
read -r -s ACCOUNT_PASSWORD
export ACCOUNT_PASSWORD ACCOUNT_EMAIL=you@example.com ACCOUNT_NAME='Your name'
docker compose exec -e ACCOUNT_PASSWORD -e ACCOUNT_EMAIL -e ACCOUNT_NAME api bun run account:create
unset ACCOUNT_PASSWORD ACCOUNT_EMAIL ACCOUNT_NAME
```

For a different port, set both `WEB_PORT` and `ACCOUNTING_PUBLIC_URL`. A deployment outside localhost requires an HTTPS public URL and a configured reverse proxy. Preserve the volume and authentication secret across upgrades. [OPERATIONS.md](docs/OPERATIONS.md) owns the deployment, capacity and recovery requirements.

## Backup and restore

Back up local SQLite and its referenced original/export files together:

```sh
bun run backup /absolute/path/to/new-backup-directory
bun run restore /absolute/path/to/new-backup-directory /absolute/path/to/new-restore-directory
```

The backup command takes a consistent database snapshot, verifies and copies its referenced objects, and writes a checksum manifest. Restore verifies the manifest, objects and SQLite integrity in a new directory; it refuses to overwrite an existing destination. To use the restored data, set `DATABASE_URL=file:/absolute/path/to/new-restore-directory/xfactura.db` and `ACCOUNTING_OBJECT_DIR=/absolute/path/to/new-restore-directory/objects`, retaining the authentication secret. Stop the target deployment before changing its configured data location.

Inside Compose, run backup with `docker compose exec api bun run backup /app/.accounting/backups/<new-name>` and copy that completed directory off the deployment volume. A backup kept only on the same volume does not provide disaster recovery. The local backup command intentionally refuses remote databases; Turso needs its provider backup/export procedure paired with the document manifest.

## Legacy paid acts

Existing deployments of the original invoicer keep its Stripe-paid AI extractions ("acte inteligente"). Their routes mount only when `DATABASE_URL` (the legacy database with the `users` table) and `STRIPE_SECRET_KEY` are set:

- `STRIPE_SECRET_KEY`: the Stripe secret key.
- `STRIPE_PRICE_300`, `STRIPE_PRICE_1000`, `STRIPE_PRICE_5000`: the Price ids of the three packs.
- `STRIPE_WEBHOOK_SECRET`: the signing secret (`whsec_...`) of the webhook endpoint. When set, `POST /stripe-webhook` verifies each delivery's signature and credits on `checkout.session.completed` and `checkout.session.async_payment_succeeded`. In the Stripe dashboard, add an endpoint for `https://<api-host>/stripe-webhook` with exactly those two events.
- `LEGACY_ALLOWED_ORIGINS`: comma-separated origins allowed by the legacy CORS, `https://xfactura.ro` by default.

Acts are credited only for a completed session whose payment is `paid`, and exactly once per session id (recorded in `users.payments`), whether the webhook or the `/plata` return page sees it first. Charging an act is a single conditional update that never takes a balance below zero.

`bun packages/xfactura-api/scripts/legacy/reconcile-acts.ts [--since=YYYY-MM-DD] [--json]` compares the credited sessions with Stripe and lists credited sessions that Stripe reports unpaid, paid sessions never credited and sessions credited twice. It only reads the database and Stripe.

## Verification

```sh
bun run test
bun scripts/rules/rollover.ts --date 2027-01-01 --check docs/ROLLOVER.md
bun run test:integration
bun run test:legacy
bun run test:perf
bun run typecheck
bun run lint
bun run format:check
bun run build:api
bun run build
bun run test:e2e
bun run validators:fetch   # pinned UBL, EN 16931, Saxon and ANAF packages
bun run test:official
```

`test:official` checks the e-Factura writer against UBL 2.1 (with `xmllint`) and CEN EN 16931 (with Java and Saxon-HE), exercises the accounting return writers with ANAF's pinned validators, and checks rejection of broken fixtures. Tests missing their required artifacts or tools report skipped, not passed. `bun run validate:official <files or directories>` applies UBL and EN 16931 checks to e-Factura invoices and credit notes, plus CIUS-RO when compiled `.xslt` or `.xsl` files are installed in `.validators/cius-ro/`; a raw `.sch` file is not loaded. [sources.json](scripts/validators/sources.json) records the artifacts and the manual CIUS-RO acquisition step.

`bun run docs:rollover` prints and regenerates the register-derived table in [ROLLOVER.md](docs/ROLLOVER.md); `bun run test` includes its drift check.

Browser tests use isolated temporary books, API port 8189 and web port 3100 by default. Each viewport gets a fresh server/database run so the growing suite respects local authentication rate limits. They exercise accounting and the existing invoicer without provider keys; artifacts are grouped under `test-results/desktop` and `test-results/mobile`. macOS uses installed Chrome; other systems need Playwright Chromium (`bunx playwright install chromium`). Keep those ports available during the tests, or move them with `XFACTURA_E2E_WEB_PORT` and `XFACTURA_E2E_API_PORT`.

The versioned API is mounted in the existing `xfactura-api` server. Its OpenAPI document is served at `/api/accounting/openapi.json`. [ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the domain boundaries and [DESIGN.md](docs/DESIGN.md) the interface conventions.

Scoped accounting agents use the shared capability API or MCP at `/api/accounting/v1/companies/{companyId}/mcp`, authenticated with a human-issued bearer credential. Credentials expire, can be revoked, end when their issuer's membership changes, and never authorize approval by an agent. [AGENT_API.md](docs/AGENT_API.md) owns the connection and approval contract, and [ROADMAP.md](docs/ROADMAP.md) tracks planned integrations. Accounting does not require an inference provider.

## License and credits

MPL-2.0; see [LICENSE](LICENSE) and [OPEN_SOURCE.md](docs/OPEN_SOURCE.md). e-Factura XML is written by `xfactura-core`; the previous generator, [josemmo/einvoicing](https://github.com/josemmo/einvoicing), remains only as the test oracle in `tools/php-oracle`. Inter is self-hosted under the [SIL Open Font License](packages/xfactura-web/public/notices/inter-OFL.txt). xFactura is independent of public institutions.
