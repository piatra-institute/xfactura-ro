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

`setup` creates private local configuration and generates an authentication secret. It preserves existing nonempty values. Configure an account through the operator CLI; public registration is disabled:

```sh
read -r -s ACCOUNT_PASSWORD
export ACCOUNT_PASSWORD
ACCOUNT_EMAIL=you@example.com ACCOUNT_NAME='Your name' bun run account:create
unset ACCOUNT_PASSWORD
bun run dev
```

Open [localhost:3000/contabilitate](http://localhost:3000/contabilitate). `dev` starts the web application, the existing API on port 8089 and the export worker. Accounting requires no Piatra, Google, Stripe or AI key. Existing provider integrations remain optional.

## Accounting coverage

Accounting runs on one append-only kernel: documents and evidence feed pure treatments, every effect is approved by a person for its exact hash (or posted under a human-approved policy), and the database itself refuses unapproved, unbalanced or altered entries. It covers the general ledger, e-Factura service invoices and credit notes in lei or foreign currency, MT940/camt.053 bank settlement, BNR rates with realized and month-end FX differences, working VAT journals, the trial balance and reviewed month close.

It is not yet a complete accounting system for a Romanian SRL: VAT settlement and declarations, payroll, assets, stock, micro and profit tax and year-end close remain to be built, and every fiscal parameter is still awaiting review by an expert contabil. [IMPLEMENTATION.md](docs/IMPLEMENTATION.md) owns current coverage, [ACCOUNTING_ENGINE.md](docs/ACCOUNTING_ENGINE.md) the exact behavior, and [ROADMAP.md](docs/ROADMAP.md) the remaining work.

The public invoicer retains its own browser-local data and JSON/PDF/XML workflows. Importing an invoice does not establish ANAF acceptance, and a VAT journal or a closed month is not a declaration.

## SQLite and Turso

Configure `.env` using [.env.example](.env.example). Local data is stored in `.accounting/xfactura.db`; immutable originals and generated exports are stored in `.accounting/objects`.

For Turso, set `DATABASE_URL` to the libSQL database URL and `DATABASE_AUTH_TOKEN` to its scoped token, then run the same migration and account commands. Keep document storage persistent and shared between API and worker. The automated integration/recovery suite currently exercises local SQLite; a live Turso deployment requires its own adapter and provider recovery verification.

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

## Verification

```sh
bun run test
bun run test:integration
bun run test:perf
bun run typecheck
bun run lint
bun run format:check
bun run build:api
bun run build
bun run test:e2e
bun run validators:fetch   # once: pinned official UBL, EN 16931 and Saxon artifacts
bun run test:official
```

`test:official` validates the e-Factura writer against the UBL 2.1 schema (with `xmllint`) and the CEN EN 16931 rules (with Java and Saxon-HE), and checks that broken documents are rejected. Without the artifacts, Java or `xmllint` it reports skipped, not passed. The national CIUS-RO rules are published only by the Ministry of Finance; place them in `.validators/cius-ro/` as [sources.json](scripts/validators/sources.json) describes. `bun run validate:official <files or directories>` validates any XML the same way.

Browser tests use isolated temporary books, API port 8189 and web port 3100. Each viewport gets a fresh server/database run so the growing suite respects local authentication rate limits. They exercise accounting and the existing invoicer without provider keys; artifacts are grouped under `test-results/desktop` and `test-results/mobile`. macOS uses installed Chrome; other systems need Playwright Chromium (`bunx playwright install chromium`). Keep these ports available during the tests.

The versioned API is mounted in the existing `xfactura-api` server. Its OpenAPI document is served at `/api/accounting/openapi.json`. [ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the domain boundaries and [DESIGN.md](docs/DESIGN.md) the interface conventions.

Scoped accounting agents use the shared capability API or MCP at `/api/accounting/v1/companies/{companyId}/mcp`. Human-issued credentials expire, can be revoked, end when their issuer's membership changes, and never approve anything. MCP supports 2025 and 2026 protocol clients; browser OAuth delegation and the built-in Piatra AI/BYOK accounting agent remain planned. [AGENT_API.md](docs/AGENT_API.md) documents capabilities, connection and exact approvals. Accounting does not require an inference provider.

## License and credits

MPL-2.0; see [LICENSE](LICENSE) and [OPEN_SOURCE.md](docs/OPEN_SOURCE.md). e-Factura XML is written by `xfactura-core`; the previous generator, [josemmo/einvoicing](https://github.com/josemmo/einvoicing), remains only as the test oracle in `tools/php-oracle`. Inter is self-hosted under the [SIL Open Font License](packages/xfactura-web/public/notices/inter-OFL.txt). xFactura is independent of public institutions.
