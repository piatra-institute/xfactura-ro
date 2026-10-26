# Default self-hosting to a local object store

Planning decision; this records intended direction and does not claim implementation.

## Decision

Use a local document volume through ObjectStore for the supported single-node Compose deployment; keep S3/Garage as adapters.

## Rationale

A mandatory separate object-storage service adds an early operating burden without proving accounting. The port preserves a path to hosted or multi-node storage.

## Consequences

Prove atomic writes, isolation, coherent database/document backups and restoration. Self-hostability does not promise support for arbitrary installations. [OPERATIONS.md](../OPERATIONS.md) owns the deployment contract.

## Revisit condition

Revisit the default when measured scale or a supported multi-node topology requires remote object storage.
