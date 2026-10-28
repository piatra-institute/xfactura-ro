# xFactura

Romanian invoicing and accounting in the existing web/API applications. The public invoicer keeps its browser-local company, invoice and inventory data. Accounting at `/contabilitate` uses authenticated, company-scoped server persistence: local SQLite by default, with an optional Turso connection.

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

The accounting engine includes year-scoped general postings, analytical accounts, evidenced configuration and incoming/outgoing UBL XML imports with bounded standard-VAT/non-VAT service treatments. Linked credits, invoice balances, settlements/refunds/fees, multiple RON bank/cash accounts, purchase accruals and completed unbilled sales use the same exact-approval flow. Purchase estimates support evidenced same-year changes/releases without changing originals or invoiced amounts. Uniform subscription invoices use 471/472 and approved monthly expense/revenue allocations, with invoice VAT recorded separately. Linked cancellation of whole future months preserves earned amounts, adjusts VAT and supports the resulting refund balance. Later invoice matching and monthly allocations avoid duplicate recognition; working VAT and 408/418/4428/471/472 controls reconcile to the ledger. Official declarations remain unfinished. See [engine contracts and limits](docs/ACCOUNTING_ENGINE.md). The earlier manual workflow, corrections, month closing, original-document downloads, collaboration and exports remain available. [Implementation evidence](docs/IMPLEMENTATION.md) and the [coverage roadmap](docs/ROADMAP.md) distinguish implemented scope from subsequent fiscal work.

## SQLite and Turso

Configure `.env` using [.env.example](.env.example). Local data is stored in `.accounting/xfactura.db`; immutable originals and generated exports are stored in `.accounting/objects`.

For Turso, set `DATABASE_URL` to the libSQL database URL and `DATABASE_AUTH_TOKEN` to its scoped token, then run the same migration and account commands. Keep document storage persistent and shared between API and worker. The automated integration/recovery suite currently exercises local SQLite; a live Turso deployment requires its own adapter and provider recovery verification.

## Schema changes

The accounting schema lives in [schema.ts](packages/xfactura-api/source/accounting/schema.ts). Business queries use Drizzle.

```sh
bun run db:generate --name=describe_the_change
bun run db:migrate
```

Review the generated migration and snapshot together. The cancellation table in `0022_deferral_cancellations.sql` is generated from `schema.ts`. Its companion `0023_deferral_cancellation_guards.sql` contains hand-written SQLite triggers; Drizzle Kit does not model those trigger definitions. `generate --custom` creates an empty migration for this unsupported DDL, rather than generating its SQL. See [Drizzle Kit custom migrations](https://orm.drizzle.team/docs/drizzle-kit-generate#custom-migrations). `0001_posting_guards.sql` is a Drizzle custom migration for database invariants that schema declarations cannot express: balanced atomic postings, immutability and closed-period protection. SQLite table rebuilds can remove triggers; recheck those guards whenever a generated migration rebuilds a protected table. The later correction migration adds its own approval, exact-line and immutable-link guards without rebuilding the original tables. Do not hand-write table migrations or apply schema pushes to accounting books.

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
bun run typecheck
bun run lint
bun run format:check
bun run build:api
bun run build
bun run test:e2e
```

Browser tests use isolated temporary books, API port 8189 and web port 3100. Each viewport gets a fresh server/database run so the growing suite respects local authentication rate limits. They exercise accounting and the existing invoicer without provider keys; artifacts are grouped under `test-results/desktop` and `test-results/mobile`. macOS uses installed Chrome; other systems need Playwright Chromium (`bunx playwright install chromium`). Keep these ports available during the tests.

The versioned API is mounted in the existing `xfactura-api` server. Its OpenAPI document is served at `/api/accounting/openapi.json`. [ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the domain boundaries and [DESIGN.md](docs/DESIGN.md) the interface conventions.

Scoped accounting agents use the shared capability API or MCP at `/api/accounting/v1/companies/{companyId}/mcp`. Human-issued credentials expire, can be revoked and cannot approve their own work. MCP supports 2025 and 2026 protocol clients; browser OAuth delegation and the built-in Piatra AI/BYOK accounting agent remain planned. [AGENT_API.md](docs/AGENT_API.md) documents capabilities, connection and exact approvals. Accounting does not require an inference provider.

## License and credits

MPL-2.0; see [LICENSE](LICENSE) and [OPEN_SOURCE.md](docs/OPEN_SOURCE.md). The existing UBL generator uses [josemmo/einvoicing](https://github.com/josemmo/einvoicing). Inter is self-hosted under the [SIL Open Font License](packages/xfactura-web/public/notices/inter-OFL.txt). xFactura is independent of public institutions.
