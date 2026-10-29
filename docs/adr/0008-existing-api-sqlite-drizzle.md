# Keep accounting in the existing API and SQLite stack

Amended by [ADR 0009](0009-pure-core-package.md). Since the kernel switchover ([ADR 0010](0010-append-only-kernel.md)) the accounting modules live in `packages/xfactura-api/source/engine`.

## Decision

Place accounting domain and adapter modules inside `packages/xfactura-api/source/accounting`. Keep the existing web/API packages. Shared contracts may use explicit package exports; a module with one application consumer does not require its own package.

Use SQLite locally and the existing libSQL configuration for optional Turso operation. PostgreSQL is not a prerequisite. Store posted RON amounts as integer bani and keep decimal strings at API boundaries. Use typed Drizzle queries, schema definitions and generated migrations. Reserve custom SQL for database invariants that cannot be expressed in the schema API.

## Consequences

Authorization and company scoping are application responsibilities, backed by company-consistent foreign keys and isolation tests. Do not describe SQLite as enforcing PostgreSQL RLS. Test transaction/idempotency behavior against each supported deployment adapter. A provider option is not proof of recovery or hosted capacity.

Regenerate schema migrations instead of editing generated SQL. Review SQLite table-rebuild migrations for their effect on custom triggers and run the immutable-posting and period-protection tests after every migration change.

## Rationale

These boundaries preserve the existing stack and simplify self-hosting. Separate packages and a PostgreSQL service added operational surface before a demonstrated need.
