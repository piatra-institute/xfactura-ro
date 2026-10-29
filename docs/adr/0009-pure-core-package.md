# Share accounting calculations through a pure core package

Amends [ADR 0008](0008-existing-api-sqlite-drizzle.md).

## Decision

Create `packages/xfactura-core` for code with more than one application consumer: money, dates, canonical hashing, document models, the UBL reader and CIUS-RO writer, bank statement parsers, the kernel's effect contracts and validation, rule packages and their resolver. The API and the browser invoicer both import it.

The package is pure. Its TypeScript configuration declares no ambient types (no DOM, Node or Bun), it performs no I/O, and rule code does not read the clock or randomness. Persistence, HTTP, MCP, authentication and the worker remain in `packages/xfactura-api`.

## Consequences

The no-account invoicer generates and validates e-Factura XML in the browser with the same calculator the ledger uses; the server PHP/WebAssembly path is removed. Hashes computed in the browser and on the server must match, so `canonical()` uses code-unit key order and publishes test vectors.

ADR 0008 still governs the database, money storage and migrations. Its statement that a single-consumer module needs no package is unchanged; core exists because there are now two consumers.

## Rationale

Duplicating invoice arithmetic between the invoicer and the ledger is how the invoicer's float and date errors arose. A compile-time pure package makes the shared code auditable and testable without a database.
