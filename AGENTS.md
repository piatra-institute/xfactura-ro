# Working in this repository

xFactura is Romanian invoicing and accounting: a browser-local invoicer and an accounting engine operated through one API and MCP. This file is the standing guidance for anyone, person or model, who changes the code. [docs/README.md](docs/README.md) says which document owns which question; read the ones your task names before you write.

## Layout

| Path | What it holds |
|---|---|
| `packages/xfactura-core` | Pure domain code shared by the API and the browser: money, hashing, dates, the e-Factura model, kernel contracts, the rule register, every Romanian treatment, return writer and cited parameter. |
| `packages/xfactura-api/source/engine` | The accounting engine: `kernel/` (commands, proposals, posting, policies, worklist), `modules/` (one per workflow), `db/` (Drizzle schema, generated migrations, database invariants), `http/` (REST, MCP, OpenAPI), `adapters/`. |
| `packages/xfactura-api/source` (outside `engine/`) | The original invoicer's endpoints. Leave them alone unless the task names them. |
| `packages/xfactura-web` | Next.js: the public invoicer and the accounting interface at `/contabilitate`. |
| `packages/xfactura-eval` | Scores agents keeping books through MCP. |
| `scripts/` | Setup, validators, rule review packets, pilot and comparison tools. |

## Rules that hold everywhere

1. **The engine computes every amount.** No interface, script, agent or model computes a tax, a total or a rounding. They choose treatments and inputs; treatments compute.
2. **One path to the books.** A treatment reads a declared plan and returns an effect; the effect becomes a hashed proposal version; a person approves that exact hash, or a person-approved policy covers it; posting re-evaluates and refuses a changed result. Do not add another way to write entries. Agents never approve.
3. **Legal values come from the register.** A parameter has a date axis, versions with effective intervals, cited clauses and a review status. Resolution returns a value or a typed gap; it never defaults and never takes the latest version. New versions enter as `extracted`. Only the accountant and the expert raise a review status: never write `interpreted`, `cases_approved` or `signed` yourself, and never state a legal value from memory without the clause it comes from.
4. **Core stays pure.** `xfactura-core` does no I/O, reads no clock and no randomness, and declares no ambient types (no DOM, Node or Bun). Persistence, HTTP and adapters belong in the API package.
5. **The database is the backstop.** Posted records are append-only. Invariants live in `packages/xfactura-api/source/engine/db/invariants.ts`, each with a plain-language rule and an attack in the invariant tests. Schema changes are generated with `bun run db:generate --name=<change>`; an applied migration is never edited. Touch the schema, migrations or invariants only when your task says it owns them.
6. **Unknown stays unknown.** A missing fact is a question to a person, a missing rule is a `RULE_GAP`, an unpublished layout is a `FORMAT_GAP`, an uncovered case is `UNSUPPORTED`. None of them becomes zero, a default or a guess.
7. **Real data never enters the repository.** `.private/` and any folder outside the repository that your task points to hold real companies' books and personal data. Read them when the task says so; write what you derive only under `.private/`. Fixtures, tests, documentation, comments and reports to be committed use synthetic companies, identifiers and amounts.
8. **Documents state what exists.** `docs/IMPLEMENTATION.md` owns coverage, `docs/ACCOUNTING_ENGINE.md` exact behaviour, `docs/AGENT_API.md` the wire contract, `docs/ROADMAP.md` open work. Change a fact in the document that owns it, in place; add no dated update sections; write one line per paragraph.
9. **Language.** Text a person reads in the product (labels, messages, error text) is Romanian. Code, comments and the summaries operations give to agents are English.

## A new workflow module

Each module ships with: its treatments in core and its operations registered in `engine.ts`, each operation declaring its summary, toolset, data classes, reversibility and external effect; its `agent.ts` (document kinds, question kinds, worklist steps, template fields); cited parameters; review specs for the readings the legal text leaves open; database guards with their attacks, when it adds tables; and a test against ANAF's validator wherever ANAF publishes one.

## Commands

Use Bun 1.4.2 and run from the repository root.

```sh
bun install --frozen-lockfile
bun test packages/xfactura-core/test/<file>.test.ts                                   # one core test file
bun test --timeout 120000 packages/xfactura-api/test/engine/<name>.integration.test.ts  # one engine test file
bun run check            # core tests, legacy tests, typecheck, lint, web build
bun run test:integration # every engine test, in four processes
bun run test:official    # ANAF and e-Factura validators; needs .validators/ and Java
bun run test:perf        # when posting or closing paths change
bun run format:check
```

While working, run the test files your change affects; run the full gates once at the end. A validator test that reports skipped has not passed: say so. Bun occasionally crashes with SIGSEGV on the integration run; `scripts/test-integration.ts` reruns the part, and a single file can simply be run again.

## Working on a task

- Stay inside the task you were given: its goal, its files, its acceptance test. If the task turns out to need something it excludes (a migration, a kernel change, another module), stop and report it instead of doing it.
- Do not commit, push, switch branches or rewrite history. Leave your changes in the working tree.
- Do not weaken, skip or delete a test to make it pass. A test that was wrong is fixed with the reason stated.
- Match the code around you: Prettier (single quotes, width 100) and ESLint as configured; no `any`; comments say what the code does and why, never how it changed.
- Finish with a report: what you changed and where, the commands you ran with their results, what you could not verify, and anything you are unsure of.
