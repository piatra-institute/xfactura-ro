import { expect, test } from '@playwright/test';
import { approveInPlace, cell, choose, entryTotals, openJournalEntry } from './support/entry';
import { signInWithCompany } from './support/session';
import { typeDate } from './support/shell';
import { mockWorklist } from './support/worklist';

test('a balanced entry with a supplier line, a new partner and a new invoice, is proposed and posted', async ({
  page,
}, info) => {
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Curățenie ${info.project.name} SRL`,
  );
  await openJournalEntry(page);
  await typeDate(page, 'Data', '16.11.2026');
  await page.getByRole('textbox', { name: 'Referință', exact: true }).fill('NC-12');
  await page
    .getByRole('textbox', { name: 'Explicație', exact: true })
    .fill('Servicii de curățenie, noiembrie');
  // The supporting document is uploaded in place and chosen.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Încarcă documentul justificativ', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'factura-fc-31.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 factura sintetică FC-31'),
  });
  await expect(page.getByRole('status')).toContainText('factura-fc-31.pdf a fost păstrat.');
  await expect(page.getByRole('combobox', { name: 'Document justificativ' })).toHaveValue(
    'factura-fc-31.pdf',
  );

  await choose(page, 'Cont, linia 1', '628');
  await cell(page, 'Debit', 1).fill('500,00');
  // The address survives a reload, and so does what was typed.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Notă contabilă nouă' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Referință', exact: true })).toHaveValue('NC-12');
  await expect(cell(page, 'Debit', 1)).toHaveValue('500,00');

  // A supplier's line names its partner, created in place, and its invoice, opened by the entry.
  await choose(page, 'Cont, linia 2', '401');
  await expect(cell(page, 'Partener', 2)).toBeVisible();
  await page.getByRole('button', { name: 'Partener nou, linia 2', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Partener nou' });
  await dialog
    .getByRole('textbox', { name: 'Denumire', exact: true })
    .fill('Curățenie Exemplu SRL');
  await dialog.getByRole('textbox', { name: 'CUI', exact: true }).fill('87654321');
  await dialog.getByRole('button', { name: 'Adaugă partenerul', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(cell(page, 'Partener', 2)).toHaveValue(/Curățenie Exemplu SRL/);
  await cell(page, 'Număr factură nouă', 2).fill('FC-31');
  await typeDate(page, 'Scadență, linia 2', '30.11.2026');
  await cell(page, 'Credit', 2).fill('300,00');
  await cell(page, 'Explicație', 2).fill('Factura FC-31');

  // Unbalanced: the engine's preview states the difference, and the submit is refused.
  const totals = entryTotals(page);
  await expect(totals).toContainText('500,00');
  await expect(totals).toContainText('300,00');
  await expect(totals).toContainText('Diferență 200,00 RON');
  await expect(totals).toContainText('Totalul debit trebuie să fie egal cu totalul credit.');
  await page.getByRole('button', { name: 'Pregătește înregistrarea', exact: true }).click();
  const refusal = page.locator('.acc-entry-refusal');
  await expect(refusal).toHaveAttribute('role', 'alert');
  await expect(refusal).toContainText('Totalul debit trebuie să fie egal cu totalul credit.');
  await expect(page).toHaveURL(/entry=new/);

  await cell(page, 'Credit', 2).fill('500,00');
  await expect(totals).toContainText('Diferență 0,00 RON');
  await expect(refusal).toHaveCount(0);
  await page.getByRole('button', { name: 'Pregătește înregistrarea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');
  await expect(page).toHaveURL(/entry=[0-9a-f-]{36}/);
  const proposal = page.locator('.acc-review');
  await expect(proposal.getByRole('rowheader', { name: '628', exact: true })).toBeVisible();
  await expect(proposal.getByRole('rowheader', { name: '401', exact: true })).toBeVisible();
  // A line's explanation reads with its account, in the review's effect table.
  await expect(proposal.getByRole('row', { name: /^401/ })).toContainText('Factura FC-31');
  await approveInPlace(proposal);
  await page.getByRole('link', { name: 'Deschide înregistrarea 1', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Înregistrarea 1 · / })).toBeVisible();
  await expect(page.locator('.acc-register-table')).toContainText('401');
  expect(errors).toEqual([]);
});

const account = (code: string, name: string, controlKind: string | null = null) => ({
  code,
  name,
  postable: true,
  controlKind,
  validFrom: '2015-01-01',
  validTo: null,
});

test('a VAT account is not offered, and lines are edited from the keyboard', async ({ page }) => {
  const previews: Record<string, unknown>[] = [];
  await mockWorklist(
    page,
    (operation, input) => {
      if (operation === 'proposals.preview') {
        previews.push(input.input as Record<string, unknown>);
        const lines = (input.input as { lines: unknown[] }).lines;
        return {
          body: {
            treatment: 'ledger.general',
            subject: 'journal:general:NC-1',
            effect: null,
            blocking: true,
            // The engine names the line an issue concerns by its place in the input.
            issues: [
              {
                code: 'ACCOUNT_DATE',
                severity: 'block',
                message: 'Contul 6022 nu este valabil la această dată.',
                path: `lines.${lines.length - 1}`,
              },
            ],
            totals: [{ currency: 'RON', debit: '1000', credit: '1000', difference: '0' }],
          },
        };
      }
      return { body: { items: [], next: null, asOfSeq: 1 } };
    },
    {
      'capabilities.list': {
        capabilities: [
          'ledger.journal',
          'ledger.general.propose',
          'proposals.preview',
          'accounts.list',
          'parties.list',
          'openItems.list',
        ].map((id) => ({ id })),
      },
      'evidence.list': {
        items: [
          {
            id: 'proof',
            filename: 'nota-sintetica.pdf',
            hash: 'a'.repeat(64),
            mediaType: 'application/pdf',
            size: 10,
            dataClasses: ['evidence'],
          },
        ],
        next: null,
      },
      'accounts.list': {
        items: [
          account('4423', 'TVA de plată', 'tax.payable'),
          account('4424', 'TVA de recuperat', 'tax.receivable'),
          account('4426', 'TVA deductibilă', 'tax'),
          account('4427', 'TVA colectată', 'tax'),
          account('5121', 'Conturi la bănci în lei'),
          account('6022', 'Cheltuieli privind combustibilii'),
        ],
        next: null,
      },
    },
  );
  await page.goto('/contabilitate?company=company&view=registers&register=jurnal&entry=new');
  await expect(page.getByRole('heading', { level: 2, name: 'Notă contabilă nouă' })).toBeVisible();

  // The VAT accounts are booked with their invoice: typing one offers nothing and points there.
  await cell(page, 'Cont', 1).fill('442');
  const listbox = page.getByRole('listbox');
  await expect(listbox.getByRole('option', { name: /^4423/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /^4424/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /^442[67]/ })).toHaveCount(0);
  await cell(page, 'Cont', 1).fill('4426');
  await expect(listbox.getByRole('option')).toHaveCount(0);
  const hint = page.getByText(
    'Contul 4426 nu se alege în nota contabilă: TVA se înregistrează odată cu factura, din',
  );
  await expect(hint).toBeVisible();
  await expect(page.getByRole('link', { name: 'Documente', exact: true }).last()).toHaveAttribute(
    'href',
    /view=documents/,
  );

  // Tab moves across a line's cells; Enter on its explanation goes on to a new line.
  await choose(page, 'Cont, linia 1', '5121');
  await expect(hint).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Debit', 1)).toBeFocused();
  await page.keyboard.type('1000,00');
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Credit', 1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell(page, 'Explicație', 1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Cont', 2)).toBeFocused();
  await choose(page, 'Cont, linia 2', '6022');
  // Typing a credit empties the debit of the same line.
  await cell(page, 'Debit', 2).fill('5,00');
  await cell(page, 'Credit', 2).fill('1000,00');
  await expect(cell(page, 'Debit', 2)).toHaveValue('');
  await cell(page, 'Explicație', 2).press('Enter');
  await expect(cell(page, 'Cont', 3)).toBeFocused();
  await page.getByRole('button', { name: 'Elimină linia 3', exact: true }).click();
  await expect(cell(page, 'Cont', 3)).toHaveCount(0);

  await page.getByRole('textbox', { name: 'Referință', exact: true }).fill('NC-1');
  await page.getByRole('textbox', { name: 'Explicație', exact: true }).fill('Notă sintetică');
  await choose(page, 'Document justificativ', 'nota', /nota-sintetica\.pdf/);
  // The engine's totals and its issue, beside the line it concerns.
  await expect(entryTotals(page)).toContainText('Diferență 0,00 RON');
  const issue = page.getByText('Contul 6022 nu este valabil la această dată.');
  await expect(issue).toBeVisible();
  await expect(
    page.locator('tr', { has: issue }).locator('xpath=preceding-sibling::tr[1]'),
  ).toHaveAttribute('data-line', /.+/);
  await expect(page.locator('tr[data-line]').nth(1).locator('td[data-invalid]')).toHaveCount(1);
  expect(previews.at(-1)).toMatchObject({
    reference: 'NC-1',
    evidenceId: 'proof',
    lines: [
      { account: '5121', side: 'D', amount: '1000.00' },
      { account: '6022', side: 'C', amount: '1000.00' },
    ],
  });
});
