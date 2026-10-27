# Deployment, subsidy and recovery

## Supported reference deployment

Provide one-command Docker Compose for web, API and worker, sharing the local SQLite/document volume. Turso can replace the local database through libSQL configuration. Default documents live in a shared local volume through ObjectStore. No Piatra account, service secret, S3 service or Garage container is required to operate the books.

Local storage uses atomic durable writes, safe company/content addressing and integrity checks. Back up the database and document manifest/bytes coherently; a backup of one without the other is incomplete. Offer an S3/Garage adapter for hosted or multi-node operation.

Self-hostable means the documented reference topology passes clean-room install, upgrade, export and restore tests. It does not promise commercial support for every operating system, storage driver, Kubernetes variant or custom fork. Publish the tested matrix and community-support boundary.

Hosted identity uses the Piatra adapter; the reference self-host identity is standalone Better Auth. Both use product-local permissions. Regular Piatra/OpenAI/OpenRouter keys call those services directly when AI is enabled, as defined in [AI.md](AI.md).

The current MCP endpoint shares the existing API and uses scoped accounting credentials. Configure the public URL consistently across web and API. If a reverse proxy rewrites Host, list its exact internal hostname in `ACCOUNTING_MCP_PROXY_HOSTS`; reference Compose sets `api`. Local installs admit loopback hostnames. Preserve Host/Origin checks and never trust arbitrary forwarded headers. [AGENT_API.md](AGENT_API.md) owns the connection procedure and unfinished browser OAuth boundary.

## Funded free hosting

Free hosted accounting is the chosen strategic subsidy, not a claim of zero operating cost. Maintain an internal operator budget that is not copied into public product documentation. Publish the resulting service/support envelope and capacity constraints without disclosing supplier costs or margins.

Before broader enrollment, approve and fund:

- Maximum aggregate monthly operating spend and an explicit funding horizon.
- Target and stop thresholds for measured infrastructure cost per active company.
- Human support hours/cost envelope, onboarding effort and escalation expectations.
- Supported company/storage/workload capacity, upload/rate limits and abuse controls.
- The admission/capacity action when a threshold is reached, with named operational ownership.

No numeric subsidy is invented by this plan. Record real measurements from pilots, including backup/restore, storage growth, ANAF retries, support and optional AI. Reassess as company/profile complexity changes.

When capacity/funding approaches the boundary, pause new admissions and arrange a published capacity/continuity plan. Preserve existing read access, evidence, exports and an orderly migration path. Never introduce surprise billing or a fiscal-correctness paywall. Any change to free-hosted pricing requires a separate product decision.

## Measured subsidy and admission model

Maintain separate internal monthly subsidy and measured-cost ledgers, onboarding-cost records, stress scenarios and an approved admission decision. Keep actual supplier costs/margins private; publish only the supported service envelope. Do not populate these ledgers with invented unit prices.

Use a parameterized monthly model with explicit units:

```text
C_m(N) = F_m + M_m + R_m + sum_i(c_s*S_i,m + c_b*B_i,m + c_p*P_i,m + c_o*O_i,m + c_h*H_i,m)
```

F is shared fixed operation; M is fiscal/legal/engineering/independent-review maintenance; R is the included incident reserve. S measures physical live storage including indexes/versions; B measures backup/replication/transfer; P measures processing/database/validator work; O measures other variable I/O; H measures human support time. Unit costs use invoices or defensible internal rates. Separate one-time import/reconciliation/support/remediation from steady-state cost and avoid double-counting labor or reserve.

Instrument bytes/copies/index overhead, backup amplification/restores/exports, CPU/database/queue time per import/report/D406/close, API retries, support incidents/minutes/severity, fiscal-release reviewer/engineering hours, active/idle tenants, adoption and migration failure. Report observed median, p95/extremes with sample size, and distinguish measured results from stress assumptions. Include annual reporting peaks, legal-change workload and simultaneous recovery, not just two ordinary months.

Admit only when stress cost for admitted tenants fits the funded monthly subsidy and committed funding covers the documented horizon plus reserves not already included. Capacity is the minimum of budget, storage, processing/queue, staffed support and demonstrated recovery limits; fiscal-maintenance personnel/funding is an additional mandatory gate. Record the approved thresholds, forecast inputs, worst-case scenario, owner and onboarding-pause action. No justified numeric capacity exists until measurements/funding/service objectives are established.

Direct provider-key AI spend is not xFactura revenue or a subsidy source. Optional operational-service revenue needs its own explicit forecast; ordinary free onboarding cannot assume customers buy migration services.

## Recovery and observability

Default hosted recovery targets remain RPO at most five minutes and RTO at most 24 hours. Prove actual results with restore drills before launch. Use off-site database/WAL and document backups, versioned retention, separately protected encryption keys and recoverable configuration.

Restore books, tax positions, evidence/artifacts, permissions and pending jobs coherently. Reconcile external submissions after recovery instead of repeating uncertain actions. Test upgrades with retained older exports/packages and compatible migration/fix-forward paths.

Alert on failed/stuck jobs, stale imports, expiring ANAF authorization, pending/rejected receipts, unreconciled sources/tax positions, dependency/storage pressure and backup/restore failures. AI-provider exhaustion is a separate failure and must leave accounting usable.

Monitor human minutes per company/period, repeated entry, exception types, traceability, validator outcomes, storage/compute/support consumption and migration effort. Show input freshness and uncertainty in the UI, not only operational dashboards.

## Launch and continuity inputs

Secure the pilot company/reviewers, official ANAF test/developer access, relevant mandates, reviewed sources/validators and their redistribution terms, funded deployment and a proven recovery path. Current institute backups do not automatically cover a new xFactura database.

Publish supported versions, operational documentation, privacy/retention behavior, incident communication and export/exit procedures. Set a monitored security intake through [SECURITY.md](SECURITY.md). Fiscal package maintenance follows [GOVERNANCE.md](GOVERNANCE.md). Use sourced retention classes and the baseline in [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md); active loss/asset history, disputes or other obligations may require longer evidence retention. Do not schedule automatic deletion from a single general period.

Managed AI payments, bank aggregation, paid signing/SLA and arbitrary deployment support are future separately justified work, not hidden prerequisites to the free release.
