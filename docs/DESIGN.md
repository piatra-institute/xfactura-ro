# Interface conventions

These conventions govern the accounting interface at `/contabilitate`. The public invoicer at `/` keeps its own black theme until it is redesigned.

## Layout

A fixed left sidebar holds the company switcher, every section (Acasă, De verificat, Întrebări, Documente, Bancă, Registre, Declarații) with a count where work waits, and at its foot Setări and the account menu. Every section is one click away; nothing a person needs to find sits below the fold. On narrow screens the sidebar becomes a drawer behind a top bar.

The company switcher lists the account's companies and ends with „Companie nouă”, which opens its own page followed by the company's setup. Nothing about other companies appears inside a company's screens.

Each section opens with a context bar: the section title, the financial year and the section's primary action. A section's parts are tabs under the context bar.

Acasă shows what needs the person now, the money position computed by the engine, and the next deadlines with their action.

## Copy

Headings and labels name things: „Profilul firmei”, „Notă contabilă nouă”, „Jurnal de vânzări”. Headings carry no slogans, no sentence-ending punctuation and no subtitle. Preserve punctuation that belongs to a company's actual name.

Write no sentence that restates what the screen already shows or explains the obvious. Text appears only to say what to do next or why something is blocked, in one short line beside the thing it concerns.

Engine summaries are written for agents. The interface renders their structure (returns, months, partners, counts) as chips, lists and tables, never their prose.

Omit metadata that has no value instead of writing „nespecificat”. Codes, identifiers, hashes and keys appear only under a collapsed „Detalii tehnice”.

Present xFactura as working software: no test-version footers, demo branding, milestone labels, ticket names or generic disclaimers. Show an unavailable capability or an unresolved fiscal decision inside its workflow, in precise factual language. Fiscal-release governance, migration gates and coverage checklists belong in documentation, not in owner-facing work items.

## Assistance

A problem carries its fix where it is shown: a missing company fact opens its control in place; a question opens its answer; a refused step names what is missing and links to the screen that supplies it.

Collapse repetition: affected returns read „D112 · ian–dec 2026”, not one sentence per month.

An empty state names the one next action, as a button.

Choices use the engine's plain-language labels; a person never types an internal value.

## Data entry

Tabular input is a table. Journal lines are rows with account, debit, credit and explanation columns, added and removed from the keyboard, with the totals and the difference shown from the engine's preview.

Pickers search by code and by name (accounts, partners, documents, open invoices) and create the missing item in place where the engine allows it.

Dates are entered and shown as 17.11.2026, months by name („noiembrie 2026”), ranges as „ian–dec 2026”, amounts as 1.234,56 RON, right-aligned in tables with tabular figures. One formatter module serves every view.

## Amounts and review

The engine computes every amount, total and balance shown. The interface formats and aligns them; it never adds them up.

Keep review centred on the retained evidence, the exact effect and a clear decision. Distinguish observed money, accounting result, estimated tax, approved tax and external fulfilment. An unknown or uncomputed value never becomes a green status or a zero.

Imports and agents use the shared API and MCP; a new module does not automatically need a mandatory data-entry screen.

## Theme and accessibility

Two themes, light and dark, follow the system setting; the account menu offers Sistem, Luminos and Întunecat and remembers the choice. Colours come from theme tokens; components use no literal colours.

Typography is Inter. Financial values use tabular figures.

Every field has a visible label. Keyboard focus is visible in both themes and never removed. Text and controls meet WCAG AA contrast in both themes. Loading, empty and error states are explicit.

Widgets with keyboard and locale behaviour (date and month fields, number fields, select, combobox, menu, dialog, table) come from `react-aria-components` under the `ro-RO` locale, styled with the theme tokens.

## Specific flows

In the supported purchase correction flow, place the correction action within its journal entry. Show the recorded and corrected amounts, reason, supporting document and exact debit/credit lines before approval. Keep the reason and evidence accessible after posting, with links between immutable journal entries. Following a journal link opens the destination entry and transfers keyboard focus to its summary before scrolling; the next Tab continues within that entry to its supporting document.

The target explanation, close, portfolio and batch-review experiences are specified in [FEATURE_VISION.md](FEATURE_VISION.md). They inherit these conventions; they are not instructions to add speculative controls. A business exception such as a missing invoice is actionable product data; a project milestone belongs in documentation.
