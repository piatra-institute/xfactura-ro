# Project and fiscal governance

## Roles and public process

Separate the Romanian Accounting Conformance specification from the xFactura implementation. Public RFCs cover changes to profile semantics, Accounting IR, fiscal treatment, autonomy, security boundaries, compatibility and licensing. An RFC states the problem, alternatives, affected profiles/packages, source evidence, migration/compatibility effects, proof obligations and decision owners.

Maintain named roles for specification stewardship, code maintenance, fiscal interpretation, independent accounting review, release operation and security response. A person may hold several roles, but the person implementing a fiscal change cannot also supply its only independent expected-result approval. An LLM is not an independent qualified fiscal reviewer.

Recruit accounting reviewers before claiming fiscal conformance. Missing reviewers keep a profile in draft/shadow use; they do not prevent publishing prototype code or technical results. Publish reviewer responsibilities and decisions without requiring confidential company evidence to be public.

Contribution rights and DCO policy live in [OPEN_SOURCE.md](OPEN_SOURCE.md); security intake lives in [SECURITY.md](SECURITY.md).

## Fiscal package release protocol

1. Capture an official source change as an issue with source bytes/hash, publication/effective dates, applicability, and affected profiles.
2. A fiscal reviewer interprets the change and resolves source conflicts, including which periods and existing positions it affects.
3. An independent accounting reviewer establishes fixed expected results and boundary/interaction cases before implementation is accepted.
4. An engineer changes the rules/mappings, with code review and explicit compatibility notes.
5. Run affected profiles, the existing corpus, property/mutation checks and exact period-specific official validators.
6. Shadow-replay eligible frozen company snapshots where operational access exists; before onboarding, replay the reviewed pilot/reference set. Retain old signed results and never mutate production books.
7. Review a per-profile/per-company impact report covering changes, unchanged cases, new exceptions and potential corrective filings.
8. Approve the release manifest with distinct fiscal and engineering sign-offs, then sign the immutable package/checksums.
9. Publish source, profile/case/validator versions, impact guidance and the compatible software range. Roll out through a pilot/canary before broader activation.

No autonomous fiscal-rule publication. A critical hotfix may narrow/withdraw a claim or stop an affected operation immediately, but it cannot silently waive independent fiscal review for new consequential treatment.

## Reproducibility and activation

Every package manifest identifies fiscal package ID, rule-set hash, software compatibility, profile/corpus/oracle versions, source snapshots and effective periods, validators, approvals and signature. Generated filings preserve these identifiers internally with their ledger/tax-position snapshot.

Signing proves the released bytes and approval chain, not legal infallibility. A later interpretation creates a new package and explicit impact/correction proposal. Preserve old artifacts, packages, receipts and documentation for reconstruction.

Activation is effective-date aware and observable. A roll-back does not rewrite postings produced under the later version. Test the downgrade/read path; a data migration that cannot be reversed must use a compatible fix-forward plan and backup proof.

## Standard and compatibility governance

Use semantic versioning for public schemas/API contracts and immutable revision IDs for profiles, oracle cases and fiscal packages. A changed expected legal outcome creates a new case/oracle revision; never move the goalposts under an existing report.

Provide adapter compatibility tests and a public process to report ambiguous cases. Any implementation can publish a reproducible conformance report with exact versions and limitations. Conformance wording and trademarks must not imply xFactura affiliation or government approval.

Keep migration and export readers compatible with previous published versions or provide tested converters and notice. A withdrawn profile remains readable in historical artifacts. Publish the reason and replacement path.

## Sources and review register

Maintain one source register containing official documents and amendments, dates/hashes, interpretation owner, case coverage, open ambiguities and retention/validation licensing requirements. Distinguish statutory requirements from project defaults and validator behavior. [REGULATORY_BASELINE.md](REGULATORY_BASELINE.md) owns the dated planning findings; located primary text is not an approved oracle.

Record publication, effective interval, affected fiscal years and knowledge/retrieval date separately. Deadline and register rules must retain changes such as the 2026 fiscal-register replacement and FY2026 D101 deadline. Verify official artifacts for each reporting cycle; do not infer an unpublished next-year package from the previous one. A revised source/package triggers obligation closure and downstream correction/eligibility review.

Review the applicable accounting-software clauses and their amendments alongside release evidence. A normative clause needs a linked control, test and operating/documentation artifact; a checklist alone is not conformance proof. [Financial-accounting document norms](https://legislatie.just.ro/Public/DetaliiDocumentAfis/173683)
