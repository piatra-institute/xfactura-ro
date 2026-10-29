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

The accounting engine includes year-scoped general postings, analytical accounts, evidenced configuration and incoming/outgoing UBL XML imports with bounded standard-VAT/non-VAT service treatments. Linked credits, invoice balances, settlements/refunds/fees, multiple RON bank/cash accounts, purchase accruals and completed unbilled sales use the same exact-approval flow. Purchase estimates support evidenced same-year changes/releases without changing originals or invoiced amounts. Explicitly estimated unbilled sales now have a separate new-information remeasurement/release workflow: non-VAT changes within the year, and normal-VAT changes within the original service month. API/MCP prepares exact signed adjustments; the existing review card verifies them. Uniform service benefits use 471/472 with approved equal-month or actual-calendar-day allocations, including partial first/last months. Daily plans retain inclusive service dates, monthly day counts and exact cumulative-floor bani; invoice VAT is recorded separately. Explicit nonuniform monthly benefits now retain exact amounts and descriptions, with separate performed-service evidence required for each positive release. Future-only reviews can change those amounts while preserving recognized months and the remaining total. Future-service cancellations preserve earned amounts. Post-invoice commercial subscription discounts use 609/709 with separate agreement evidence, preserving the original services and schedule. A credit-backed partial cancellation of unprovided services instead reduces 471/472 and reallocates the positive future remainder under the original method. Explicit monthly plans require the exact smaller future amounts, with no month increased or date changed. API/MCP prepares the source-linked credit; human approval preserves earned amounts and the UI verifies its before/after plan. Successive partial scope credits and a later full cancellation now retain an immutable ordered history per source invoice, including documented monthly benefits. Each credit uses the current reduced schedule and cumulatively reconciles recognized, cancelled and remaining amounts. Additional future services can now be invoiced separately through API/MCP, with an immutable parent link and their own value, schedule, tax point and settlement position. Multiple additions leave the original invoice and recognized amounts unchanged; their own credits and calendar reviews remain separate. Prospective calendar changes, including after partial scope cancellation, have a separate exact review: preserve the original allocation method and recognized months, redistribute the same future value and retain an immutable amendment without a journal. Daily and explicit-benefit amendments may end mid-month; their effective start remains the first day of a future month. The review binds the latest posted scope credit and the cumulative earlier reductions, redistributing only the reduced future balance and preserving all credits and VAT. Agents prepare the change; the UI verifies its before/after plan, agreement and linked credit. Supplier/customer advances retain bank payments, advance invoices, final-invoice regularization, unused-balance credits and full/partial pre-invoice refunds through 4092/419. Separate partial refunds preserve the unreturned balance for a later invoice, original-rate VAT, ordered history and exact current approval. Later invoices and allocations avoid duplicate expense, revenue and VAT; working registers and itemized controls reconcile to the ledger. Official declarations remain unfinished. See [engine contracts and limits](docs/ACCOUNTING_ENGINE.md). The earlier manual workflow, corrections, month closing, original-document downloads, collaboration and exports remain available. [Implementation evidence](docs/IMPLEMENTATION.md) and the [coverage roadmap](docs/ROADMAP.md) distinguish implemented scope from subsequent fiscal work.

Retained e-Factura ZIP imports now preserve the original archive, extracted XML/signature/supporting files and an immutable provenance manifest. API/MCP imports the batch atomically; invoice review links the exact ZIP/member bytes. Signature and ANAF acceptance verification remain separate from import.

Bank imports accept bounded complete RON MT940 and camt.053.001.02/.08 files alongside CSV, retaining booked/value dates, references, batch details and original bytes. API/MCP reuses known movements across sources; the bank screen verifies source details and exact balances. Daily statement chains must cover the month without gaps before closing. See the [bank-file workflow](docs/AGENT_API.md#bank-file-workflow) for configuration, limits and unsupported variants.

## SQLite and Turso

Configure `.env` using [.env.example](.env.example). Local data is stored in `.accounting/xfactura.db`; immutable originals and generated exports are stored in `.accounting/objects`.

For Turso, set `DATABASE_URL` to the libSQL database URL and `DATABASE_AUTH_TOKEN` to its scoped token, then run the same migration and account commands. Keep document storage persistent and shared between API and worker. The automated integration/recovery suite currently exercises local SQLite; a live Turso deployment requires its own adapter and provider recovery verification.

## Schema changes

The accounting schema lives in [schema.ts](packages/xfactura-api/source/accounting/schema.ts). Business queries use Drizzle.

```sh
bun run db:generate --name=describe_the_change
bun run db:migrate
```

Review the generated migration and snapshot together. The archive tables, indexes, foreign keys and checks in `0026_invoice_archives.sql` are generated from `schema.ts`. Its companion `0027_invoice_archive_guards.sql` contains hand-written SQLite triggers for immutable manifests and member projections; Drizzle Kit does not model those trigger definitions. `generate --custom` creates an empty migration for this unsupported DDL, rather than generating its SQL. See [Drizzle Kit custom migrations](https://orm.drizzle.team/docs/drizzle-kit-generate#custom-migrations). `0001_posting_guards.sql` is a Drizzle custom migration for database invariants that schema declarations cannot express: balanced atomic postings, immutability and closed-period protection. SQLite table rebuilds can remove triggers; recheck those guards whenever a generated migration rebuilds a protected table. The later correction migration adds its own approval, exact-line and immutable-link guards without rebuilding the original tables. Do not hand-write table migrations or apply schema pushes to accounting books.

The bank tables, indexes, foreign keys and checks in `0028_bank_statement_files.sql` are also Drizzle-generated. `0029_bank_statement_file_guards.sql` defines only the SQLite manifest/projection invariants that Drizzle cannot represent. A populated `0027` upgrade proves existing CSV source identities and cached results remain intact.

`0030_subscription_discounts.sql` is a Drizzle custom migration for SQLite trigger changes only. It adds no table, index or column: existing invoice-credit records retain commercial discounts. Drizzle creates the empty custom migration shell; its unsupported trigger definitions are written and tested explicitly, including a populated `0029` upgrade.

`0031_deferral_reschedules.sql` is generated from the Drizzle schema, including its table, index, checks and foreign keys. `0032_deferral_reschedule_guards.sql` is a generated custom-migration shell with explicitly written SQLite invariants for exact approval, immutable calendars and current-plan releases/credits. Populated `0021`, `0029` and `0030` books preserve their original facts, hashes, approvals and postings through the upgrade. Applied migrations are never rewritten.

`0033_unbilled_sale_adjustments.sql` is generated from the Drizzle schema. Its companion `0034_unbilled_sale_adjustment_guards.sql` contains explicitly written SQLite posting/projection invariants in a generated custom-migration shell. A populated `0032` upgrade preserves old facts, hashes and an approved unbilled-invoice match through both migrations.

`0035_actual_day_allocation_guards.sql` changes only two SQLite triggers for versioned actual-day plans and future calendar amendments; no table, index or column change is required. Drizzle generated the custom shell/snapshot/journal entry; the unsupported trigger definitions are explicit SQL. A populated pre-daily `0034` upgrade preserves old monthly schedules, hashes, cached commands and pending approvals.

`0036_scope_reduction_guards.sql` also requires no table, index or column change. Drizzle generated the custom shell/snapshot/journal entry; explicit SQLite trigger definitions protect partial scope credits and the resulting effective releases. Existing full cancellations and old pending approvals remain compatible through a populated `0035` upgrade.

`0037_deferral_supplements.sql` is Drizzle-generated table/index/check/foreign-key DDL. Its companion `0038_deferral_supplement_guards.sql` is a generated custom shell with explicit SQLite origin, projection and immutability invariants. A populated `0036` upgrade preserves old books and exact pending approvals; earlier applied migrations are unchanged.

`0039_evidenced_monthly_guards.sql` changes only three SQLite triggers for explicit monthly benefit plans, separate service confirmations and reviewed future amounts. Drizzle generated the custom shell/snapshot/journal entry after ordinary schema generation confirmed no DDL change. The unsupported trigger definitions are explicit SQL. A populated `0038` upgrade preserves old monthly facts, hashes, cached results and an approved release. Earlier applied migrations are unchanged.

`0040_documented_scope_guards.sql` changes only two SQLite triggers for explicit monthly scope credits and the resulting release plan. Drizzle generated the custom shell/snapshot/journal entry after ordinary schema generation confirmed no DDL change; the unsupported trigger definitions are written explicitly. A populated `0039` upgrade preserves an existing explicit monthly plan, service evidence and an approved release. Earlier applied migrations are unchanged.

`0041_reduced_calendar_guards.sql` changes two SQLite triggers for calendar reviews and releases after partial scope cancellation. Drizzle generated the custom shell/snapshot/journal entry; the unsupported trigger definitions are written explicitly. Ordinary schema generation reports no DDL change. A populated `0040` upgrade preserves an approved earlier calendar, its hash and all original financial records; applying it after upgrade adds no journal. Earlier applied migrations are unchanged.

Drizzle-generated `0042_sequential_service_credits.sql` adds the cancellation sequence and replaces the one-per-source unique index. Its generated custom companion `0043` supplies only unsupported SQLite trigger definitions. A populated `0041` upgrade preserves the existing credit and an approved reduced monthly release before accepting another credit. Earlier applied migrations remain unchanged.

For partial bank refunds, Drizzle generated the `0045` table rebuild and index/foreign-key copy. The generated custom `0044`/`0046` shells prepare and restore only the unsupported SQLite triggers around that rebuild. Populated `0025`/`0043` upgrades retain existing refunds and old exact approvals; applied migrations remain unchanged.

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
