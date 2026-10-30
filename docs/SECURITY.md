# Security and trust boundaries

## Assets and authority

Protect company records/evidence, identities/memberships, ANAF and provider credentials, signing permissions, release keys, audit history and backups. Treat owners, accountants, jobs, documents, provider outputs and integration callbacks as distinct principals or untrusted inputs.

Host administrators can ultimately alter their own infrastructure; append-only application records do not prove immunity to a fully compromised host. Signed releases, retained manifests, restricted operations and independent backups provide detection/recovery evidence. Do not promise impossible tamper-proof self-hosting.

## Threat model

| Threat | Required controls and verification |
|---|---|
| Cross-company exposure or IDOR | Company-scoped commands and typed queries, company-consistent foreign keys, object/export/job isolation, membership checks before replay/execution and adversarial authorization tests. SQLite/Turso credentials stay in trusted backend processes. |
| Malicious/compromised accountant | Least-privilege roles, explicit mandates, exact-version approvals, no evidence rewriting, recorded corrections, revocation and anomalous-activity audit. |
| Prompt injection or compromised AI output | Documents are data; typed/schema-validated proposals; deterministic source authority/commands; no raw SQL, credential access or arbitrary tool execution. What an agent extracts from a PDF or a photo is recorded as `extracted`, with each field's citation checked against the file's text layer and the document's arithmetic checked by the engine; every proposal reading it needs a person's acknowledgement (`SOURCE_EXTRACTED`), a policy posts it only if it names that code, and an e-Factura copy of the same invoice outranks it (`BETTER_SOURCE`). A transcribed bank statement whose citations do not hold is refused. |
| Malicious PDF/image/XML, XXE or expansion bombs | Isolated parsers/converters, disabled external entities/network fetches, resource/time/page/dimension limits, quarantine and fuzz tests. Implemented PDF text reader (`evidence.read`, `adapters/pdf-text.ts`): pdf.js in a separate Bun process per file, at most two at a time; 20 MiB in, 200 pages, 2 MiB of text, 512 MiB resident (a watchdog thread kills the process: decompression bombs), 10 s wall time (the process is killed). The process gets the PDF on stdin and an empty environment (no secrets), loads no `.env`, auto-installs nothing, cannot load native addons, and has no `fetch`, WebSocket or WebAssembly; pdf.js gets no font/CMap/wasm URL, loads no fonts and runs its worker on the same thread (pdf.js 6 has no eval path). Every outcome is typed (`encrypted`, `corrupt`, `too_large`, `timeout`, `failed`) and never crashes the API; tests cover corrupt, encrypted, 201-page, text-limit, decompression-bomb, deeply nested and timed-out PDFs. Images get no server-side decoding or OCR: `evidence.read` in `image` mode judges the format from the leading bytes (JPEG, PNG, GIF, WebP; HEIC, AVIF, TIFF and BMP refused) and reads the dimensions from the header alone, refusing a side over 8000 px and a file over 3.75 MiB (5 MiB of base64). CSV bank exports are parsed in-process (`xfactura-core/src/bank/csv.ts`): 2 MB, 2000 movements, a declared encoding with undefined bytes refused, unterminated quotes refused. Not yet: an OS sandbox (network namespace, seccomp) around the reader, which runs with the API's user and filesystem access. |
| ZIP bombs/path traversal | Implemented archive import: central-directory/lazy stream reader, 10 MiB compressed/per-file, 40 MiB expanded, 100 entries and 200:1 expansion; actual sizes/CRC checked. No path extraction to disk. Reject unsafe/duplicate paths, links, special/encrypted/nested files and unsupported methods. Every XML member shares UTF-8/DTD/complexity controls. Original archive/member bytes and immutable provenance survive failed-batch retries and restore. Signatures remain unverified evidence. |
| CSV formula injection and hostile Unicode | Safe spreadsheet exports, text escaping without modifying stored evidence, encoding tests and displayed identifier checks. |
| SSRF and data exfiltration | Provider endpoint allowlists, restricted egress, no document-chosen URLs, private-network protections and verified redirects/downloads. |
| Stolen ANAF/provider/bank credentials | Encryption with separately protected keys, masked UI/logs/exports, rotation/revocation, scoped access and audited use; live bank credentials are outside initial scope. |
| Forged/replayed callbacks and external-action retries | Signed/authenticated integrations, replay protection, idempotency, durable attempts and explicit uncertain-result state. |
| Dependency/release compromise | Pinned lockfiles/images, provenance/SBOM/license review, signed fiscal/software manifests and isolated update/release credentials. |
| Backup compromise or restore drift | Encrypted off-site copies, restricted deletion/access, key recovery, retention policy, restore drills and reconciliation of pending external attempts. |

Implement concrete limits and negative cases before enabling each parser/integration; a future cloud/provider switch cannot bypass them. Default self-host file storage must reject traversal and use atomic immutable writes within the configured volume.

## Delegated accounting access

The implemented agent grants are company-scoped, expiring and revocable; their authority also depends on the delegating human's current membership and role. Grants cannot contain approval, membership-management or credential-management capabilities. Keep API credentials separate from Piatra/OpenAI/OpenRouter inference credentials. Store only token hashes; retain agent/delegator attribution without placing bearer credentials in audit events, command results or ordinary exports. Identical issuance retries can recover the credential through installation-secret derivation, but cannot revive expired/revoked authority.

Recheck grants before cached command responses, source/export downloads and queued export processing/completion. Agent keys have separate idempotency namespaces from human commands. Exact action reviews preserve input/effect hashes, approval and execution lineage under database guards; changed accounting state blocks execution. Tests cover direct legacy-route bypasses, forbidden self-approval, role downgrade, revocation, tenant boundaries and restore/retry behavior.

MCP accepts explicit accounting bearer credentials and requires authentication on every request. Browser cookies cannot authenticate MCP; invalid bearer headers cannot fall back to a browser session. Browser OAuth delegation is not yet implemented. Host validation admits the public hostname, local loopback for local installs and explicitly configured internal proxy hosts. A supplied Origin must match the public origin; session-cookie mutations still require it. Never use arbitrary forwarded headers to extend that allowlist. Request bodies over REST and MCP are bounded to 70 MiB, stored originals to 64 MiB, and inline MCP source reads to 256 KiB: agents read evidence only through `evidence.read`, whose every text result is at most its `maxBytes` (≤ 256 KiB); the whole file (`evidence.get`, the REST download) is for people only, and no grant can name it. The one exception is an image (`evidence.read`, mode `image`): a JPEG, PNG, GIF or WebP of at most 3.75 MiB, so at most 5 MiB of base64, the per-image limit of the common vision models, sent to an agent's own model because the engine does no OCR; over MCP it travels once, as an image content block. A PDF, or any file that is not such an image, never leaves whole.

## AI evidence egress

Before transmission, disclose the provider and company-approved purpose. Record evidence identifiers/hashes, provider/model, time, actor, policy/action, and selected retention/privacy configuration. Do not claim a provider enforces a retention mode unless its account/API contract supports it.

Keep raw prompts and credentials out of ordinary logs. Store only the evidence/proposal/audit material needed for reconstruction under its retention class. Enabling a model does not grant it access to unrelated companies or the full document store.

## Disclosure, retention and gates

Before the public pilot, publish a monitored private vulnerability intake, responsible maintainers, response process and advisory route. Enable repository private reporting where supported; do not invent an unmonitored security address.

Classify source documents, accounting/fiscal records, identity data, usage and integration logs separately. Verify period-specific retention/erasure requirements with the fiscal/source register; avoid copying old retention figures from a single unreviewed source.

Security release gates include tenant/portfolio isolation, distinct professional/product/submission authority, permission revocation during queued work, exact signed-payload/receipt linkage, malicious parser inputs, export safety, credential recovery, supply-chain checks and clean-room restoration. [TESTING.md](TESTING.md) owns executable proof and [OPERATIONS.md](OPERATIONS.md) owns recurring operation.
