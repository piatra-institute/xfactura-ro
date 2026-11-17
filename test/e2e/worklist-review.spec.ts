import { expect, test } from '@playwright/test';
import { chooseOption, openSection, selectButton } from './support/shell';
import { mockWorklist, openWorkRow, workItem, workRow } from './support/worklist';
import type { WorkItem } from '../../packages/xfactura-web/components/accounting/work-model';

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
  await openWorkRow(page.locator('.acc-work-row'));
  const reason = '     scurt     ';
  await page.getByLabel('Motivul închiderii').fill(reason);
  await page.getByRole('button', { name: 'Închide cu motiv', exact: true }).click();
  await expect(page.locator('.accounting').getByRole('alert')).toHaveText(
    'Motivul trebuie să conțină cel puțin 10 caractere fără spațiile de la capete.',
  );
  expect(reasons).toEqual([reason]);
});

test('items that share a cause collapse across pages into one row and keep each return and its steps', async ({
  page,
}, info) => {
  const cause = (axis: string, message: string) => ({
    id: `fact:${axis}`,
    kind: 'fact' as const,
    message,
    subject: { kind: 'profile', id: axis },
  });
  const vat = cause('vat.status', 'Regimul TVA al companiei nu este înregistrat.');
  const labels: WorkItem['labels'] = {
    kind: { label: 'Declarație', type: 'text' },
    period: { label: 'Perioadă', type: 'period' },
    status: { label: 'Stare', type: 'text' },
    gap: { label: 'Ce lipsește', type: 'text' },
    question: { label: 'Întrebare', type: 'text' },
  };
  const obligation = (kind: string, period: string, causes = [vat]) => {
    const question = causes[0]
      ? { kind: 'profile.fact', subject: causes[0].subject, params: { axis: causes[0].subject.id } }
      : null;
    return workItem(`obligation.due:obligation:${kind}|${period}`, {
      kind: 'obligation.due',
      subject: { kind: 'obligation', id: `${kind}|${period}` },
      severity: 'block',
      period,
      message: `Mesaj distinct pentru ${kind} ${period}`,
      ...(causes.length ? { causes } : {}),
      details: {
        kind,
        period,
        status: 'blocked',
        gap: causes.map((item) => item.message).join(' ') || 'Lipsește regula.',
        ...(question ? { question } : {}),
      },
      labels,
      next: question
        ? [{ operation: 'questions.ask', by: 'agent', allowed: true, inputHint: question }]
        : [],
    });
  };
  const first = obligation('D300', '2026-01');
  const second = obligation('D300', '2026-02');
  const informative = obligation('D394', '2026-01');
  const third = obligation('D300', '2026-03');
  const otherCause = obligation('D112', '2026-01', [
    cause('employer', 'Nu este înregistrat dacă firma are salariați.'),
  ]);
  // Its first cause is another fact: it waits on that one first.
  const laterCause = obligation('D406', '2026-01', [
    cause('entity.form', 'Forma juridică a companiei nu este înregistrată.'),
    vat,
  ]);
  const uncaused = obligation('D100', '2026-01', []);
  const sameText = workItem('Același text, fără cauză', { message: vat.message });
  const otherKind = workItem('question.needed:proposal:p', {
    kind: 'question.needed',
    subject: { kind: 'proposal', id: 'p' },
    severity: 'block',
    message: 'Propunerea Factură așteaptă un răspuns.',
    causes: [vat],
    next: first.next,
  });
  const items = [
    first,
    second,
    informative,
    third,
    otherCause,
    laterCause,
    uncaused,
    sameText,
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
  await expect(group).toHaveAttribute('data-cause', 'fact:vat.status');
  const toggle = group.locator('.acc-work-toggle').first();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText(vat.message);
  // The cause's returns, grouped by return with their months collapsed.
  const chips = group.locator(':scope > .acc-work-line .acc-chip');
  await expect(chips).toHaveText(['D300 · ian–feb 2026', 'D394 · ian 2026', 'Blocant']);
  for (const item of [otherCause, laterCause, uncaused, sameText])
    await expect(workRow(page, item.id)).toBeVisible();
  await expect(workRow(page, otherCause.id).locator('.acc-work-title')).toHaveText(
    'D112 · ianuarie 2026',
  );
  await expect(workRow(page, first.id)).toHaveCount(0);
  await page.getByRole('button', { name: 'Mai multe elemente' }).click();
  await expect(chips).toHaveText(['D300 · ian–mar 2026', 'D394 · ian 2026', 'Blocant']);
  await page.screenshot({ path: info.outputPath('grouped-causes.png'), fullPage: true });
  await toggle.click();
  await expect(group.locator('.acc-work-members .acc-work-title')).toHaveText([
    'D300 · ianuarie 2026',
    'D300 · februarie 2026',
    'D394 · ianuarie 2026',
    'Propunerea Factură așteaptă un răspuns.',
    'D300 · martie 2026',
  ]);
  const row = workRow(page, first.id);
  // A return's row opens its lifecycle in Declarații.
  await expect(row.getByRole('link', { name: 'Deschide', exact: true })).toHaveAttribute(
    'href',
    /view=deadlines.*return=D300%7C2026-01/,
  );
  await openWorkRow(row);
  const details = row.getByRole('region');
  await expect(details.locator('.acc-work-details').first()).toContainText(
    'Ce lipsește' + vat.message,
  );
  await expect(details).toContainText('Blocată');
  await expect(
    details.getByRole('link', { name: 'Deschide declarația în Declarații', exact: true }),
  ).toHaveAttribute('href', /view=deadlines.*return=D300%7C2026-01/);
  await expect(details.getByRole('button')).toHaveCount(0);
});

test('details read under the engine labels, typed, while codes and identifiers stay closed', async ({
  page,
}, info) => {
  const documentId = '00000000-0000-4000-8000-000000000001';
  const partyId = '00000000-0000-4000-8000-000000000002';
  const evidenceId = '00000000-0000-4000-8000-000000000003';
  const treasuryId = '00000000-0000-4000-8000-000000000004';
  const item = workItem('Document de verificat', {
    subject: { kind: 'document', id: documentId },
    // The labels and types the engine gives each detail (`labels`).
    labels: {
      kind: { label: 'Tip', type: 'text' },
      number: { label: 'Număr', type: 'text' },
      date: { label: 'Dată', type: 'date' },
      partyId: { label: 'Partener', type: 'id', kind: 'party' },
      evidenceId: { label: 'Document justificativ', type: 'id', kind: 'evidence' },
      members: { label: 'Copii ale documentului', type: 'text' },
      currency: { label: 'Monedă', type: 'text' },
      totals: { label: 'Totaluri', type: 'text' },
      authority: { label: 'Sursă', type: 'text' },
      treasuryAccountId: { label: 'Cont de trezorerie', type: 'id', kind: 'treasuryAccount' },
      bookingDate: { label: 'Data operațiunii', type: 'date' },
      amountMinor: { label: 'Sumă', type: 'minor', currencyKey: 'currency' },
      operation: { label: 'Operațiune', type: 'text' },
      mediaType: { label: 'Tip fișier', type: 'text' },
      size: { label: 'Dimensiune (octeți)', type: 'count' },
      uploadId: { label: 'Încărcare SPV', type: 'id', kind: 'spvUpload' },
      artifactId: { label: 'Declarație', type: 'id', kind: 'artifact' },
      code: { label: 'Cod', type: 'text' },
      blocks: { label: 'Declarații afectate', type: 'text' },
    },
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
      code: 'FACT_UNKNOWN',
      blocks: ['D300|2026-01', 'D300|2026-02', 'D394|2026-Q1'],
      unlabelled: 'cheie-fara-eticheta',
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
  const row = page.locator('.acc-work-row');
  // The returns a detail names are the row's chips, grouped by return.
  await expect(row.locator('.acc-work-facts .acc-chip')).toHaveText([
    'D300 · ian–feb 2026',
    'D394 · trim. I 2026',
  ]);
  await openWorkRow(row);
  // The value a detail shows beside its label, the label matched whole.
  const whole = (text: string) => new RegExp(`^${text.replace(/[.*+?^$|()[\]\\{}]/g, '\\$&')}$`);
  const value = (label: string) =>
    row
      .locator('.acc-work-details')
      .first()
      .locator(':scope > div')
      .filter({ has: page.locator(':scope > dt', { hasText: whole(label) }) })
      .locator(':scope > dd');
  await expect(value('Partener')).toHaveText('Furnizor Sintetic SRL');
  await expect(row.getByRole('link', { name: 'DOC-1.xml' }).first()).toBeVisible();
  await expect(value('Cont de trezorerie')).toHaveText('Cont curent EUR');
  await expect(value('Sursă')).toHaveText('Fișier XML încărcat');
  await expect(value('Dată')).toHaveText('01.01.2026');
  await expect(value('Data operațiunii')).toHaveText('02.01.2026');
  await expect(value('Declarații afectate')).toHaveText('D300 · ian–feb 2026D394 · trim. I 2026');
  // Decimals keep every digit; minor units are read in their currency's minor digits.
  await expect(row.locator('.acc-work-amount')).toHaveText([
    '1.000,01 EUR',
    '234,56 EUR',
    '1.234,57 EUR',
    '1.234,57 EUR',
  ]);
  await expect(row.locator('.acc-work-amount').first()).toHaveCSS('text-align', 'right');
  await expect(value('Operațiune')).toHaveText('Verifică răspunsurile din SPV');
  await expect(value('Dimensiune (octeți)')).toHaveText('1.200');
  const technical = row.locator('.acc-technical');
  await expect(technical).not.toHaveAttribute('open');
  const text = await row.innerText();
  for (const code of [documentId, partyId, evidenceId, treasuryId, '123457', 'FACT_UNKNOWN'])
    expect(text).not.toContain(code);
  expect(text).not.toContain('cheie-fara-eticheta');
  await page.screenshot({ path: info.outputPath('readable-details.png'), fullPage: true });
  await technical.getByText('Detalii tehnice', { exact: true }).click();
  for (const code of [documentId, partyId, evidenceId, treasuryId, 'FACT_UNKNOWN'])
    await expect(technical).toContainText(code);
  await expect(technical).toContainText('cheie-fara-eticheta');
  await expect(technical.getByText('Încărcare SPV', { exact: true })).toBeVisible();
  await expect(technical.getByText('Declarație', { exact: true })).toBeVisible();
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
    // The sidebar's count of open questions is a read.
    if (operation === 'questions.list') return { body: { items: [], next: null } };
    writes.push(operation);
    return { body: {} };
  });
  await page.goto('/contabilitate?view=review');
  for (const item of items) await openWorkRow(workRow(page, item.id));
  const incompleteRow = page.locator('[data-work-id="Acțiune incompletă"]');
  await expect(
    incompleteRow.getByText('Aprobă această previzualizare: sunt necesare date suplimentare.'),
  ).toBeVisible();
  // Once a row is open, only its title remains a button above what it holds.
  await expect(incompleteRow.getByRole('region').getByRole('button')).toHaveCount(0);
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
  await expect(blockRow.getByRole('region').getByRole('button')).toHaveCount(0);
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
    await openWorkRow(page.locator('.acc-work-row'));
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
  await openWorkRow(row);
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
  await expect(selectButton(page, 'Familie')).toContainText('Documente');
  await expect(selectButton(page, 'Severitate')).toContainText('Avertismente și blocante');
  // „Toate” clears a filter from the address.
  await chooseOption(page, 'Severitate', 'Toate');
  await expect(page).not.toHaveURL(/severity=/);
  await expect(page).toHaveURL(/family=documents/);
  await openSection(page, 'Registre');
  await expect(page).not.toHaveURL(/family=|severity=/);
  await openSection(page, 'Documente');
  await expect(page).toHaveURL(/view=documents/);
  await expect(page).not.toHaveURL(/family=|severity=|section=/);
  await openSection(page, 'De verificat');
  await expect(selectButton(page, 'Familie')).toContainText('Toate');
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
