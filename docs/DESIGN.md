# Interface conventions

The existing xFactura interface establishes the visual system: a pure black background, white text and controls, muted gray secondary text, and Inter typography. Accounting uses the same theme across sign-in, forms, registers and review flows. Do not introduce a white content canvas.

Headings name the task or content. They do not use slogans, marketing copy or sentence-ending punctuation. Use direct Romanian labels such as „Autentificare”, „Companie nouă” and „Jurnal contabil”. Preserve punctuation that belongs to a company's actual name.

Present xFactura as working software. Do not add test-version footers, demo branding, internal milestone labels or generic disclaimers to the interface. Show an unavailable capability or unresolved fiscal decision in its relevant workflow, using precise factual language.

Fiscal-release governance, migration activation gates and implementation coverage checklists belong in project documentation. Do not render them as owner-facing work items.

Use explicit labels, native inputs and meaningful empty, loading and error states. Avoid focus rings, glows and thick outlines. Show keyboard focus through a subtle border change on fields and an underline on actions. Keep financial values exact and aligned. Show factual coverage limitations where they affect a decision; keep implementation ticket names out of product copy.

In the supported purchase correction flow, place the correction action within its journal entry. Show the recorded and corrected amounts, reason, supporting document and exact debit/credit lines before approval. Keep the reason and evidence accessible after posting, with links between immutable journal entries. Following a journal link opens the destination entry and transfers native keyboard focus to its summary before scrolling; the next Tab continues within that entry to its supporting document.
