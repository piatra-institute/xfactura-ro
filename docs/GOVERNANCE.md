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

## Rule review in two tiers

Every parameter version starts `extracted`: its clauses say where the value comes from, but no qualified person has confirmed it. Two kinds of reviewer raise it. Neither can be an LLM, nor the engineer who wrote the rule or its review spec.

| Tier | Reviewer | Statuses it permits | Unlocks |
|---|---|---|---|
| `interpreted` | A partner accountant | `interpreted`, `cases_approved` | Shadow use |
| `signed` | The expert contabil (CECCAR member), with a qualified electronic signature | `signed` (and the lower ones) | Posting and filing |

### Review specs

A person writes a review spec for each parameter, from the cited clauses (`xfactura-core/src/ro/reviews/specs/`). A spec holds:
- the engine's reading in one sentence, and the alternative reading;
- three to five worked cases, which run the engine's own treatments under both readings;
- the question, and the expert's estimated minutes;
- the gaps the readings could not source.

Where a clause's text is not in `.sources/`, the spec says so instead of reading it from memory. The packet generator never writes readings, cases or questions; a key without a spec gets no packet.

### Generating a packet

`bun scripts/review/packet.ts --keys a,b` builds one packet over the keys. `--act <sourceId>` builds the act's mechanical rows instead, about 20 to a packet; each interpretation gets its own packet. A packet holds:
- **identity:** an id derived from its content, and every version of each key with its value, scope, dates and clauses (not its status);
- **sources:** each clause with its locator, its summary, the registered snapshot SHA-256 and the excerpt anchors (`reviews/anchors.ts`);
- **readings and cases:** the two readings, and each case's facts and outcomes under both;
- **the question:** A the engine's reading, B the alternative, C free text;
- **scope:** the profiles and returns affected (`reviews/catalogue.ts`).

The output goes to `.reviews/packets/` (not committed):
- `<id>.pdf`, in Romanian with Noto Sans embedded. It has a form field per answer, the reviewer's name, CECCAR number and role, and an empty signature field. `packet.json` and `context.json` are attached.
- `<id>.md`, the same content for reading.

The **packet hash** is the SHA-256 of `packet.json`, the packet's canonical JSON. The packet holds nothing that depends on the day or on local files, so regenerating the PDF does not change the hash.

`context.json` is not hashed. It holds:
- the generation date and the next deadline of each parameter;
- each excerpt with its SHA-256, cut from the local `.sources/` copy. PDFs are read with poppler's `pdftotext`. When the copy is missing or has drifted, it holds "excerpt unavailable" with the reason instead.

The hash still pins each excerpt through the registered snapshot hash and the anchors it is cut by.

### Answering, signing and importing

The reviewer:
1. ticks A, B or C for each question, writing the text for C;
2. fills in their name, CECCAR number and role;
3. for the expert: signs the PDF in its signature field with a qualified electronic signature, in Adobe Reader or the signature provider's tool, and changes nothing after signing.

The owner keeps the signed PDF outside the repository (for example in `.private/reviews/`), because it carries the signer's certificate.

`bun scripts/review/import.ts <answered.pdf> --tier signed|interpreted [--publish-identity]`:
- extracts `packet.json` as `declarations.importSigned` extracts a declaration's XML (`pdfAttachments`). It refuses a packet that is not the canonical JSON of a valid packet, or that does not match its id.
- **For `signed`:** requires a signature dictionary (`pdfHasSignature`) whose byte range ends at the end of the file, so nothing was appended after signing. The tooling does not verify the qualified certificate; the record says `present_not_verified`.
- reads the answers from the form. It refuses an unanswered question, or a C without its text.
- writes a `ReviewRecord` to `xfactura-core/src/ro/reviews/records/`, with:
  - the packet and its hash;
  - the tier and the reviewer's role;
  - the date (the signature's `/M`);
  - the decisions;
  - the file's SHA-256 and signature state;
  - the hashes of the excerpts the file showed.

A reviewer's name and CECCAR number are public in the CECCAR register. Publishing them in this repository still needs the reviewer's consent, so only `--publish-identity` writes them. Without it, the record holds the role and the file's hash, and the kept file names the signer.

Importing changes no status. A person sets the version's status in its source file and commits it together with the record.

### What binds a status, and what voids it

`reviewProblems` runs as a core test over the default register (`xfactura-core/test/reviews.test.ts`). It refuses any version with status `interpreted`, `cases_approved` or `signed` unless:
- a record of the right tier answered A for the version's parameter; and
- the packet regenerated for that version hashes like the packet the record holds. The regenerated packet swaps in the version's item, rebuilt from today's register, spec, clauses, anchors and catalogue.

So any of these changes voids the answer, and the check names what changed:
- the value, scope or dates of a reviewed version (from, to, reviewed through, knowledge date), its clauses, or its withdrawal;
- a clause's locator, summary, status, snapshot hash or anchors;
- the readings, the question, a case's facts, or any case's outcome (the cases rerun against the changed register);
- the profiles or returns in scope.

In a batch, the other answers stand. A B or C answer binds nothing: the engineer changes the rule or the spec, and the parameter gets a new packet.

### The queue

`bun scripts/review/queue.ts` ranks the parameters below `signed` by reach × risk × urgency ÷ minutes:
- **reach:** the catalogue's estimate, 1 to 3, with the profiles it covers;
- **risk:** 3 for a tax amount, 2 for a filing rejection, 1 for presentation;
- **urgency:** 3, 2 or 1 when the next deadline of the annotated returns falls within 31 days, within 92 days, or later (the obligations calendar's deadline parameters);
- **minutes:** from the spec.

It prints the next packets to prepare. It lists the keys whose annotations or spec are missing, and never guesses them.

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
