# Reset the accounting schema and separate regression from independent oracles

## Decision

The accounting database contains no production books, so the kernel starts from a new baseline migration. The 53 previous migrations, the upgrade tests and the old engine modules are removed once their workflows are ported. Git retains the previous engine.

The previous integration tests' literal expected values become scenario suites that use only the capability interface. They are a regression oracle, not an independent one: they were written alongside the code that produced them.

Independent evidence comes from sources the engine does not compute: the fiscal fixtures in [FISCAL_FIXTURES.md](../FISCAL_FIXTURES.md), hand-computed payroll and FX cases, official schematron and ANAF validators, ANAF's precompleted VAT return, and the pilot company's accepted e-Factura XML, filed declarations, bank statements and its previous accountant's books.

## Consequences

Real pilot data and anything derived from it stay in a private, ignored fixtures directory. Tests that need it, or the Java validator sidecar, report as skipped rather than passed when it is absent.

## Rationale

Preserving hashes and migrations for books that do not exist would constrain the kernel without protecting anyone. Agreement between correlated implementations is not proof of fiscal correctness.
