# Accounting capabilities and MCP

The implemented API covers general-ledger proposals and financial-year reports, company chart/configuration records, domestic RON service invoices/credits, purchase accruals and later-invoice matching, invoice positions, bank/cash settlements and working VAT registers. It does not calculate full tax positions, generate official declarations, submit to ANAF or establish replacement eligibility. [ACCOUNTING_ENGINE.md](ACCOUNTING_ENGINE.md) specifies the engine capabilities and their limits. The built-in accounting agent and browser OAuth delegation remain planned. External clients can already use MCP with an explicitly issued accounting credential.

## One contract

The capability catalogue lives inside `packages/xfactura-api/source/accounting`, alongside its deterministic handlers. It owns input/output schemas, operation permissions, effects and approval requirements. The existing web command routes and MCP invoke the same handlers. The browser's aggregate overview and binary downloads remain compatibility projections; they do not grant extra agent authority.

For a company ID:

| Interface | Endpoint |
|---|---|
| Authorized discovery | `GET /api/accounting/v1/companies/{companyId}/capabilities` |
| Typed invocation | `POST /api/accounting/v1/companies/{companyId}/capabilities/{capabilityId}` |
| MCP Streamable HTTP | `/api/accounting/v1/companies/{companyId}/mcp` |
| OpenAPI | `GET /api/accounting/openapi.json` |

Discovery reports only implemented capabilities available to the current principal, including their schemas. Money uses exact decimal strings. Mutations require an `Idempotency-Key` of 8–128 letters/digits/underscore/dot/colon/hyphen; a retry reuses both key and input. Reads accept empty input where specified. Domain commands recheck authority before returning a cached result.

## Implemented surface

| Capabilities | Behavior |
|---|---|
| `books.summary` | Company identity and trial balance. |
| `years.list`, `years.create`, `accounts.list`, `accounts.create` | Financial/fiscal years and company chart; configuration changes are human-only. |
| `regimes.read`, `regimes.record`, `policies.read`, `policies.record` | Evidenced effective-dated company configuration; changes are human-only. |
| `rules.list`, `obligations.catalogue` | Draft calculation/specification references; no applicability or declaration claim. |
| `ledger.propose`, `ledger.revise`, `ledger.post`, `ledger.balance` | General and opening entries, exact approved execution and year-scoped reports. |
| `invoices.import`, `invoices.list`, `invoices.get`, `invoices.propose` | Retained UBL facts and bounded domestic service treatments. |
| `invoices.proposeCreditNote`, `invoices.reviseCreditNote` | Linked current-period commercial credits retaining the original tax treatment. |
| `positions.get`, `positions.list` | Dated invoice receivables/payables, credits, settlements and refunds. |
| `accruals.propose`, `accruals.revise` | Evidenced service purchases in 408, with estimated recoverable VAT awaiting the invoice in 4428. |
| `accruals.matchInvoice`, `accruals.reviseMatch` | Exact partial/grouped later-invoice matches; clear the unbilled liability without another expense. |
| `accruals.get`, `accruals.list`, `accruals.reconcile` | Dated unbilled positions and reconciliation to the selected year's 408/4428 balances. |
| `treasury.accounts`, `treasury.createAccount`, `treasury.recordCash` | RON bank/cash mappings and documented cash facts; mapping changes are human-only. |
| `settlements.propose`, `settlements.revise` | Exact partial/grouped allocations, refunds and fees for retained movements; post with `ledger.post` after human approval. |
| `vat.entries`, `vat.summary` | Source-linked working registers and ledger reconciliation; no official return. |
| `evidence.list`, `evidence.read`, `evidence.record` | Source metadata, immutable originals and content-addressed upload. |
| `proposals.list`, `proposals.get` | Exact versions, approval/posting state and deterministic posting lines. |
| `books.proposeOpening`, `books.proposePurchase`, `books.revisePurchase` | Prepare the existing opening or domestic service-purchase interpretation. |
| `books.approve`, `books.post` | Human approval, then exact approved posting. |
| `corrections.propose`, `corrections.revise`, `corrections.withdraw`, `corrections.post` | Linked current-year purchase correction/reversal mechanics. Approval uses `books.approve`. |
| `bank.importStatement`, `bank.movements`, `statements.list` | Bounded CSV import, movements and statement balances. |
| `reviews.request`, `reviews.list`, `reviews.approve`, `reviews.execute` | Prepare, inspect, approve and execute exact payment-match or month-close snapshots. |
| `journals.list`, `activity.list`, `jobs.list` | Immutable entries, attribution and durable export status. |
| `exports.request`, `exports.download` | Frozen export job and authenticated download descriptor. |
| `agents.issue`, `agents.list`, `agents.revoke` | Human management of delegated credentials. |
| `company.invite`, `company.revoke` | Human company-owner membership management. |

`bank.match` and `periods.close` preserve explicit human actions from the existing UI. Agents cannot invoke these direct actions; they prepare an action review and execute its approved hash. The engine never moves bank funds.

List inputs have `limit` (default 25, maximum 100) and optional `cursor`; outputs contain `items` and `nextCursor`. Proposals support kind, pending/approved/posted/withdrawn status and accounting-date bounds. Movements support matched status and date bounds; journals support kind and date bounds. A cursor is scoped by the endpoint and company; reuse the same filters while paging. Pages are live views, not a frozen export. Evidence uploads accept canonical base64, at most 10 MiB decoded; request bodies are bounded to 15 MiB. Evidence reads inline at most 256 KiB and otherwise return an authenticated download path.

## Delegate accounting access

A human owner or reviewer issues a grant through `agents.issue`, with their normal session cookie and required `Origin` header:

```json
{
  "name": "Accounting assistant",
  "scopes": ["books.summary", "proposals.list", "proposals.get", "books.proposePurchase", "books.post"],
  "expiresAt": "2026-11-15T00:00:00Z"
}
```

Choose a future expiry within 90 days and the smallest required scope list. The response includes a credential beginning `xfa_`. Send it only as `Authorization: Bearer …` to the intended xFactura instance. It is an accounting credential, separate from any Piatra AI/OpenAI/OpenRouter inference key. Agents cannot issue grants, manage membership, approve proposals or approve action reviews, even if the delegating human is an owner.

Grants are company-scoped, identify the delegating human, expire and can be revoked. Current human membership and permissions constrain every use. Owners can revoke any company grant; reviewers can manage their own grants. Scope expansion or revival requires a new grant. Human and agent command keys have separate namespaces; audit events preserve the agent ID and delegator.

Credential material is derived from the installation secret and issuance command identity so an identical issuance retry can recover a lost response. The database stores its hash, not the bearer credential; command results, ordinary exports and audits omit the credential. Revoked/expired issuance cannot be replayed to recover a working grant. Retain the installation secret across recovery. Local backups contain authentication records and grant hashes and need the same protection as the original database.

## MCP connection

MCP runs inside the existing API, using the official TypeScript SDK. It supports 2026-07-28 per-request serving and stateless 2025 compatibility. No separate accounting server or process is required. Example client code, with the accounting credential obtained separately:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'company-accounting-agent', version: '1' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(new StreamableHTTPClientTransport(
  new URL(`${process.env.XFACTURA_URL}/api/accounting/v1/companies/${process.env.XFACTURA_COMPANY}/mcp`),
  { authProvider: { token: async () => process.env.XFACTURA_AGENT_TOKEN } },
));
const result = await client.callTool({
  name: 'proposals.list',
  arguments: { input: { status: 'pending', limit: 25 } },
});
await client.close();
```

Tool names match capability IDs. Arguments contain `input` and, for mutations, `idempotencyKey`. Tool discovery excludes unavailable scopes and every human-only action. Model elicitation or text saying “approved” cannot grant accounting authority. Domain failures are tool errors with stable codes such as `APPROVAL_REQUIRED` or `STALE_APPROVAL`; authentication failure rejects the HTTP request. No subscription stream or hidden MCP session carries workflow authority.

Browser cookies do not authenticate MCP. Browser OAuth consent, resource/audience-bound OAuth tokens and protected-resource discovery remain deferred work. Do not configure OAuth-only clients as though that flow already exists. This endpoint currently accepts manually issued scoped accounting credentials.

Host validation admits the configured public hostname and local loopback names for a local installation. A reverse proxy that changes `Host` needs its exact internal hostname in `ACCOUNTING_MCP_PROXY_HOSTS` (comma-separated); the reference Compose configuration supplies `api`. There is no wildcard or trust in client-supplied forwarded headers. Any supplied `Origin` must match the configured public origin; ordinary session-cookie mutations retain their mandatory Origin check.

## Approval and recovery

For a legacy purchase, prepare a proposal, read its source/effect, and retain its `id`, `version` and `hash`. A human uses `books.approve`. The agent reads approval status and calls `books.post` with that exact version/hash. Revisions invalidate old approvals; posting still rechecks closed periods and accounting constraints.

General, invoice and accrual proposals use `ledger.post`; a `books.post` grant cannot authorize them. Accrual matches retain original journal/year/hash, available balance and exact allocation. A competing match returns `STALE_ACCRUAL_MATCH`; refresh with `accruals.reviseMatch` and obtain a fresh human approval. `ACCRUAL_CONTROL_DIFFERENCE` on close requires reconciling actual 408/4428 opening/matching data. Configuration changes remain human-only. `books.summary` requires `financialYearId` when the company has several financial years; `ledger.balance` always names the year.

For matching or closing, call `reviews.request` with one of:

```json
{"operation":"bank.match","input":{"movementId":"…","proposalId":"…","amount":"100.00"}}
```

```json
{"operation":"periods.close","input":{"month":"2026-10-01"}}
```

The result contains the exact effect and its hash. A human inspects it and calls `reviews.approve` with `{ "id": "…", "hash": "…" }`; the agent later calls `reviews.execute` with the same pair. Both approval and execution recompute the checked state. New allocations, corrected purchase amounts or changed close inputs invalidate the corresponding review. A close snapshot conservatively binds the checked company accounting state, so unrelated new accounting work can also require a fresh close review.

All effects, approvals, execution results and retries persist in SQLite. Restarting MCP or the API does not grant authority or lose approval state. Queued exports retain agent identity and recheck live scope, expiry and membership before processing and completion. Revocation blocks cached retries, downloads and queued work. Local restore tests reproduce an approved review and execute it once without changing the original installation's books.

[IMPLEMENTATION.md](IMPLEMENTATION.md) owns executable proof. [ROADMAP.md](ROADMAP.md) owns the remaining OAuth, built-in agent, bookkeeping and fiscal milestones.
