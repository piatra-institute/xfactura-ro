import { expect, test } from '@playwright/test';
import { openSection } from './support/shell';
import { mockWorklist, workItem } from './support/worklist';

test('a padded dismissal reason reaches the engine and shows its error', async ({ page }) => {
  const item = workItem('Document de clasat', {
    next: [
      {
        operation: 'work.dispose',
        by: 'human',
        allowed: true,
        inputHint: {
          id: 'Document de clasat',
          fingerprint: 'a'.repeat(64),
          disposition: 'no_booking',
        },
      },
    ],
  });
  const reasons: unknown[] = [];
  await mockWorklist(page, (operation, input) => {
    if (operation === 'work.list') return { body: { items: [item], next: null, asOfSeq: 1 } };
    if (operation === 'work.get') return { body: { state: 'open', item, disposition: null } };
    if (operation === 'work.dispose') {
      reasons.push(input.reason);
      return {
        status: 422,
        body: {
          error: {
            code: 'VALIDATION',
            message:
              'Motivul trebuie să conțină cel puțin 10 caractere fără spațiile de la capete.',
          },
        },
      };
    }
    return { body: {} };
  });
  await page.goto('/contabilitate?view=review');
  await page.locator('.acc-work-item > summary').click();
  const reason = '     scurt     ';
  await page.getByLabel('Motivul închiderii').fill(reason);
  await page.getByRole('button', { name: 'Închide cu motiv', exact: true }).click();
  await expect(page.locator('.accounting').getByRole('alert')).toHaveText(
    'Motivul trebuie să conțină cel puțin 10 caractere fără spațiile de la capete.',
  );
  expect(reasons).toEqual([reason]);
});

test('matching structured causes collapse across pages and keep each return and its steps', async ({
  page,
}, info) => {
  const gap = 'Lipsesc regimul TVA și perioada fiscală.';
  const question = {
    kind: 'profile.fact',
    subject: { kind: 'company', id: 'company' },
    params: { axis: 'vat.status', year: 2026 },
  };
  const obligation = (id: string, period: string, details: Record<string, unknown> = {}) =>
    workItem(id, {
      kind: 'obligation.due',
      subject: { kind: 'obligation', id },
      severity: 'block',
      period,
      message: `Mesaj distinct pentru ${id}`,
      details: { kind: 'D300', status: 'blocked', gap, question, ...details },
      next: [
        {
          operation: 'questions.answer',
          by: 'human',
          allowed: true,
          inputHint: { questionId: id },
        },
      ],
    });
  const first = obligation('D300|2026-01', '2026-01');
  const second = obligation('D300|2026-02', '2026-02', {
    question: {
      params: { year: 2026, axis: 'vat.status' },
      subject: { id: 'company', kind: 'company' },
      kind: 'profile.fact',
    },
  });
  const third = obligation('D300|2026-03', '2026-03');
  const differentQuestion = obligation('D112|2026-01', '2026-01', {
    kind: 'D112',
    question: { ...question, params: { axis: 'employer', year: 2026 } },
  });
  const differentBlockers = obligation('D394|2026-01', '2026-01', {
    gap: 'Lipsește și regimul încasării.',
    kind: 'D394',
  });
  const unstructured = obligation('D100|2026-01', '2026-01', { kind: 'D100', question: null });
  const sameMessage = obligation('D101|2026', '2026', { kind: 'D101', question: null });
  sameMessage.message = unstructured.message;
  const otherKind = workItem('Alt element cu aceeași întrebare', {
    details: first.details,
    next: first.next,
  });
  const items = [
    first,
    second,
    third,
    differentQuestion,
    differentBlockers,
    unstructured,
    sameMessage,
    otherKind,
  ];
  await mockWorklist(page, (operation, input) => {
    if (operation === 'work.list')
      return {
        body: {
          items: input.after ? [third] : items.filter((item) => item !== third),
          next: input.after ? null : 'obligations:page2',
          asOfSeq: 1,
        },
      };
    if (operation === 'work.get')
      return {
        body: {
          state: 'open',
          item: items.find((item) => item.id === input.id),
          disposition: null,
        },
      };
    return { body: {} };
  });
  await page.goto('/contabilitate?view=review');
  const group = page.locator('.acc-work-cause');
  await expect(group).toHaveCount(1);
  await expect(group).not.toHaveAttribute('open');
  await expect(group.locator(':scope > summary')).toContainText(gap);
  await expect(group.locator(':scope > summary')).toContainText('2 declarații');
  await expect(page.locator('[data-work-id="D112|2026-01"]')).toBeVisible();
  await expect(page.locator('[data-work-id="D394|2026-01"]')).toBeVisible();
  await expect(page.locator('[data-work-id="D100|2026-01"]')).toBeVisible();
  await expect(page.locator('[data-work-id="D101|2026"]')).toBeVisible();
  await expect(page.locator('[data-work-id="Alt element cu aceeași întrebare"]')).toBeVisible();
  await expect(page.locator('[data-work-id="D300|2026-01"]')).not.toBeVisible();
  await page.getByRole('button', { name: 'Mai multe elemente' }).click();
  await expect(group.locator(':scope > summary')).toContainText('3 declarații');
  await page.screenshot({ path: info.outputPath('grouped-causes.png'), fullPage: true });
  await group.locator(':scope > summary').click();
  await expect(group.locator('.acc-work-message')).toHaveText([
    'Declarația D300 · 2026-01',
    'Declarația D300 · 2026-02',
    'Declarația D300 · 2026-03',
  ]);
  const row = page.locator('[data-work-id="D300|2026-01"]');
  await row.locator(':scope > summary').click();
  await expect(row.getByText(first.message, { exact: true })).toBeVisible();
  // Obligation actions open the return's complete lifecycle in Declarații.
  await expect(
    row.getByRole('link', { name: 'Deschide declarația în Declarații', exact: true }),
  ).toHaveAttribute('href', /view=deadlines.*return=D300%7C2026-01/);
  await expect(row.getByRole('button')).toHaveCount(0);
});

test('document details show names and exact decimals while identifiers and minor units stay closed', async ({
  page,
}, info) => {
  const documentId = '00000000-0000-4000-8000-000000000001';
  const partyId = '00000000-0000-4000-8000-000000000002';
  const evidenceId = '00000000-0000-4000-8000-000000000003';
  const treasuryId = '00000000-0000-4000-8000-000000000004';
  const item = workItem('Document de verificat', {
    subject: { kind: 'document', id: documentId },
    details: {
      kind: 'invoice.received',
      number: 'DOC-1',
      date: '2026-01-01',
      partyId,
      evidenceId,
      members: [documentId],
      currency: 'EUR',
      totals: { net: '1000.01', tax: '234.56', gross: '1234.57' },
      authority: 'ubl_upload',
      treasuryAccountId: treasuryId,
      bookingDate: '2026-01-02',
      amountMinor: '123457',
      operation: 'spv.refresh',
      mediaType: 'application/xml',
      size: 1200,
      uploadId: 'anaf-upload',
      artifactId: 'anaf-artifact',
    },
  });
  await mockWorklist(
    page,
    (operation) => {
      if (operation === 'work.list') return { body: { items: [item], next: null, asOfSeq: 1 } };
      if (operation === 'work.get') return { body: { state: 'open', item, disposition: null } };
      if (operation === 'parties.get')
        return { body: { id: partyId, name: 'Furnizor Sintetic SRL' } };
      if (operation === 'documents.get')
        return { body: { id: documentId, number: 'DOC-1', date: '2026-01-01', evidenceId } };
      if (operation === 'treasury.accounts')
        return { body: { items: [{ id: treasuryId, name: 'Cont curent EUR' }], next: null } };
      return { body: {} };
    },
    {
      'evidence.list': {
        items: [
          {
            id: evidenceId,
            filename: 'DOC-1.xml',
            hash: 'a'.repeat(64),
            mediaType: 'application/xml',
            size: 1200,
          },
        ],
        next: null,
      },
    },
  );
  await page.goto('/contabilitate?view=review');
  const row = page.locator('.acc-work-item');
  await row.locator(':scope > summary').click();
  await expect(row.getByText('Furnizor Sintetic SRL', { exact: true })).toBeVisible();
  await expect(row.getByRole('link', { name: 'DOC-1.xml' }).first()).toBeVisible();
  await expect(row.getByText('Cont curent EUR', { exact: true })).toBeVisible();
  await expect(row.getByText('Fișier XML încărcat', { exact: true })).toBeVisible();
  await expect(row.locator('.acc-work-amount')).toHaveText([
    '1.000,01 EUR',
    '234,56 EUR',
    '1.234,57 EUR',
  ]);
  await expect(row.locator('.acc-work-amount').first()).toHaveCSS('text-align', 'right');
  await expect(row.getByText('Verifică răspunsurile din SPV', { exact: true })).toBeVisible();
  await expect(row.getByText('1200 octeți', { exact: true })).toBeVisible();
  const technical = row.locator('.acc-technical');
  await expect(technical).not.toHaveAttribute('open');
  const text = await row.innerText();
  for (const id of [documentId, partyId, evidenceId, treasuryId, '123457'])
    expect(text).not.toContain(id);
  await page.screenshot({ path: info.outputPath('readable-details.png'), fullPage: true });
  await technical.getByText('Detalii tehnice', { exact: true }).click();
  for (const id of [documentId, partyId, evidenceId, treasuryId, '123457'])
    await expect(technical).toContainText(id);
  await expect(technical.getByText('Identificatorul încărcării', { exact: true })).toBeVisible();
  await expect(technical.getByText('Identificatorul declarației', { exact: true })).toBeVisible();
});

test('incomplete steps have no button, mismatched previews stay disabled and blocking items cannot be dismissed', async ({
  page,
}) => {
  const action = (id: string, inputHint: Record<string, unknown>) =>
    workItem(id, {
      kind: 'action.awaitingDecision',
      subject: { kind: 'action', id },
      next: [{ operation: 'actions.approve', by: 'human', allowed: true, inputHint }],
    });
  const incomplete = action('Acțiune incompletă', { id: 'incomplete' });
  const mismatch = action('Acțiune schimbată', { id: 'mismatch', previewHash: 'a'.repeat(64) });
  const blocking = workItem('Mesaj SPV necitit', {
    kind: 'spv.message',
    severity: 'block',
    next: [
      {
        operation: 'work.dispose',
        by: 'human',
        allowed: true,
        inputHint: { id: 'blocked', fingerprint: 'a'.repeat(64), disposition: 'dealt_with' },
      },
    ],
  });
  const unrelated = workItem('Pas fără formular', {
    next: [{ operation: 'payroll.reges.record', by: 'human', allowed: true, inputHint: {} }],
  });
  const staleJournal = workItem('Notă de revizuit', {
    kind: 'proposal.stale',
    details: { treatment: 'ledger.general' },
    next: [
      {
        operation: 'proposals.revise',
        by: 'agent',
        allowed: true,
        inputHint: { proposalId: 'journal', input: {} },
      },
    ],
  });
  const items = [incomplete, mismatch, blocking, unrelated, staleJournal];
  const writes: string[] = [];
  await mockWorklist(page, (operation, input) => {
    if (operation === 'work.list') return { body: { items, next: null, asOfSeq: 1 } };
    if (operation === 'work.get')
      return {
        body: {
          state: 'open',
          item: items.find((item) => item.id === input.id),
          disposition: null,
        },
      };
    if (operation === 'actions.get')
      return {
        body: {
          id: input.id,
          previewHash: 'b'.repeat(64),
          preview: { month: '2026-01', findings: [] },
        },
      };
    writes.push(operation);
    return { body: {} };
  });
  await page.goto('/contabilitate?view=review');
  for (const item of items) await page.locator(`[data-work-id="${item.id}"] > summary`).click();
  const incompleteRow = page.locator('[data-work-id="Acțiune incompletă"]');
  await expect(
    incompleteRow.getByText('Aprobă această previzualizare: sunt necesare date suplimentare.'),
  ).toBeVisible();
  await expect(incompleteRow.getByRole('button')).toHaveCount(0);
  const mismatchRow = page.locator('[data-work-id="Acțiune schimbată"]');
  await expect(
    mismatchRow.getByText('Previzualizarea s-a schimbat. Reîncarcă lista înainte de aprobare.'),
  ).toBeVisible();
  await expect(
    mismatchRow.getByRole('button', { name: 'Aprobă această previzualizare' }),
  ).toBeDisabled();
  const blockRow = page.locator('[data-work-id="Mesaj SPV necitit"]');
  await expect(
    blockRow.getByText(
      'Acest element blochează și nu poate fi închis până când problema nu este rezolvată.',
    ),
  ).toBeVisible();
  await expect(blockRow.getByLabel('Motivul închiderii')).toHaveCount(0);
  await expect(blockRow.getByRole('button')).toHaveCount(0);
  for (const id of [unrelated.id, staleJournal.id])
    await expect(page.locator(`[data-work-id="${id}"]`).getByRole('link')).toHaveCount(0);
  expect(writes).toEqual([]);
});

for (const state of ['resolved', 'disposed'] as const)
  test(`an item that becomes ${state} while open loses its steps`, async ({ page }) => {
    const item = workItem('Document care se schimbă', {
      next: [
        {
          operation: 'work.dispose',
          by: 'human',
          allowed: true,
          inputHint: { id: 'one', fingerprint: 'a'.repeat(64), disposition: 'no_booking' },
        },
      ],
    });
    let current: 'open' | typeof state = 'open';
    let reads = 0;
    await mockWorklist(page, (operation) => {
      if (operation === 'work.list') return { body: { items: [item], next: null, asOfSeq: 1 } };
      if (operation === 'work.get') {
        reads++;
        return {
          body: {
            state: current,
            item: current === 'resolved' ? null : item,
            disposition:
              current === 'disposed' ? { reason: 'Verificat de persoana responsabilă.' } : null,
          },
        };
      }
      return { body: {} };
    });
    await page.goto('/contabilitate?view=review');
    await page.locator('.acc-work-item > summary').click();
    await expect(page.getByLabel('Motivul închiderii')).toBeVisible();
    current = state;
    await page.getByRole('button', { name: 'Reîncarcă lista', exact: true }).click();
    await expect(
      page.getByText(
        state === 'resolved'
          ? 'Elementul nu mai așteaptă verificare.'
          : 'Elementul a fost închis. Verificat de persoana responsabilă.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Motivul închiderii')).toHaveCount(0);
    expect(reads).toBeGreaterThan(1);
  });

test('refresh after a decision uses fresh cursors and retains items from the second page', async ({
  page,
}) => {
  const first = workItem('Document din prima pagină', {
    next: [
      {
        operation: 'work.dispose',
        by: 'human',
        allowed: true,
        inputHint: { id: 'first', fingerprint: 'a'.repeat(64), disposition: 'no_booking' },
      },
    ],
  });
  const second = workItem('Document din a doua pagină');
  const replacement = workItem('Alt document în prima pagină');
  let changed = false;
  const cursors: unknown[] = [];
  await mockWorklist(page, (operation, input) => {
    if (operation === 'work.list') {
      cursors.push(input.after);
      return {
        body: input.after
          ? { items: [second], next: null, asOfSeq: 2 }
          : {
              items: [changed ? replacement : first],
              next: changed ? 'fresh:cursor' : 'old:cursor',
              asOfSeq: changed ? 2 : 1,
            },
      };
    }
    if (operation === 'work.get')
      return {
        body: { state: 'open', item: input.id === first.id ? first : second, disposition: null },
      };
    if (operation === 'work.dispose') changed = true;
    return { body: {} };
  });
  await page.goto('/contabilitate?view=review');
  await page.getByRole('button', { name: 'Mai multe elemente' }).click();
  await expect(page.locator('[data-work-id="Document din a doua pagină"]')).toBeVisible();
  const row = page.locator('[data-work-id="Document din prima pagină"]');
  await row.locator(':scope > summary').click();
  await row.getByLabel('Motivul închiderii').fill('Verificat fără înregistrare.');
  await row.getByRole('button', { name: 'Închide cu motiv', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('[data-work-id="Alt document în prima pagină"]')).toBeVisible();
  await expect(page.locator('[data-work-id="Document din a doua pagină"]')).toBeVisible();
  expect(cursors).toContain('fresh:cursor');
  await expect(page.getByRole('button', { name: 'Mai multe elemente' })).toHaveCount(0);
});

test('filters belong to De verificat and the selected tab shows keyboard focus', async ({
  page,
}) => {
  await mockWorklist(page, () => ({ body: { items: [], next: null, asOfSeq: 1 } }));
  await page.goto('/contabilitate?company=company&view=review&family=documents&severity=warn');
  await expect(page.getByRole('combobox', { name: 'Familie' })).toHaveValue('documents');
  await openSection(page, 'Registre');
  await expect(page).not.toHaveURL(/family=|severity=/);
  await openSection(page, 'Documente');
  await expect(page).toHaveURL(/view=documents/);
  await expect(page).not.toHaveURL(/family=|severity=|section=/);
  await openSection(page, 'De verificat');
  await expect(page.getByRole('combobox', { name: 'Familie' })).toHaveValue('');
  await openSection(page, 'Setări');
  // The keyboard reaches the selected part after the context bar's action, with a visible ring.
  await page.getByRole('link', { name: 'Adaugă documente', exact: true }).focus();
  await page.keyboard.press('Tab');
  const selected = page.getByRole('tab', { name: 'Companie', exact: true });
  await expect(selected).toBeFocused();
  await expect(selected).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Exerciții și luni', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=settings&section=periods/);
  await expect(page).not.toHaveURL(/family=|severity=/);
});
