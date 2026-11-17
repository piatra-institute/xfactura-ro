import { expect, test } from '@playwright/test';
import { iban } from '../../packages/xfactura-api/test/engine/fixtures/bank';
import { formatMinor } from '../../packages/xfactura-web/components/accounting/format';
import type { Summary } from '../../packages/xfactura-web/components/accounting/workspace';
import { capability } from './support/books';
import {
  approveInPlace,
  choose,
  entryTotals,
  openJournalEntry,
  select,
  cell,
} from './support/entry';
import { keep, signInWithCompany } from './support/session';
import { chooseMonth, chooseOption, openSection, openTab, typeDate } from './support/shell';

test('a reviewed opening is posted, reported and closed', async ({ page }, info) => {
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Servicii ${info.project.name} SRL`,
  );
  await keep(page, 'balanta-deschidere.pdf', 'Balanța de deschidere 2026');

  await openSection(page, 'De verificat');
  await chooseOption(page, 'Familie', 'Propuneri');
  await expect(
    page.getByText('Niciun element pentru filtrele alese.', { exact: true }),
  ).toBeVisible();
  // The bank account the opening's 5121 belongs to, so Acasă shows its balance.
  await capability(page, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  await openJournalEntry(page);
  await typeDate(page, 'Data', '01.01.2026');
  await select(page, 'Tip', 'Deschidere');
  await page.getByRole('textbox', { name: 'Referință', exact: true }).fill('DESCHIDERE-2026');
  await page
    .getByRole('textbox', { name: 'Explicație', exact: true })
    .fill('Sold inițial la bancă');
  await choose(page, 'Document justificativ', 'balanta', /balanta-deschidere\.pdf/);
  await choose(page, 'Cont, linia 1', '5121');
  await cell(page, 'Debit', 1).fill('1000,00');
  await choose(page, 'Cont, linia 2', '1012');
  await cell(page, 'Credit', 2).fill('1000,00');
  await expect(entryTotals(page)).toContainText('Diferență 0,00 RON');
  await page.getByRole('button', { name: 'Pregătește înregistrarea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');

  // The proposal opens in place, for approval, at an address of its own.
  await expect(page).toHaveURL(/entry=[0-9a-f-]{36}/);
  const proposal = page.locator('.acc-review');
  await expect(
    proposal.getByRole('heading', { name: 'Notă contabilă', exact: true }),
  ).toBeVisible();
  await expect(proposal.getByRole('rowheader', { name: '5121', exact: true })).toBeVisible();
  await approveInPlace(proposal);
  await openSection(page, 'Acasă');
  const summary = await capability<Summary>(page, 'company.summary');
  const money = page.getByRole('region', { name: 'Bani', exact: true });
  await expect(money.locator('.acc-statement-line', { hasText: 'Cont curent' })).toContainText(
    formatMinor(summary.cash.accounts[0]!.balance.minor, 'RON'),
  );
  await expect(money).toContainText('1.000,00 RON');

  await openSection(page, 'Registre');
  await expect(page.getByRole('link', { name: /5121/ }).first()).toBeVisible();
  await openTab(page, 'Registrul jurnal');
  await chooseMonth(page, 'Luna', '2026-01');
  await expect(page.getByText(/1\. 2026-01-01 · DESCHIDERE · Sold inițial la bancă/)).toBeVisible();

  await openSection(page, 'Setări');
  await openTab(page, 'Exerciții și luni');
  const january = page.getByRole('listitem').filter({ hasText: /^ianuarie 2026/ });
  await expect(january).toContainText('deschisă');
  await january.getByRole('button', { name: 'Verifică luna ianuarie 2026', exact: true }).click();
  const close = page.getByRole('region', { name: 'Închiderea lunii ianuarie 2026', exact: true });
  await expect(close.getByText('Nicio constatare.', { exact: true })).toBeVisible();
  await expect(close.getByRole('rowheader', { name: '5121', exact: true })).toBeVisible();
  await close.getByRole('button', { name: 'Aprobă închiderea', exact: true }).click();
  await expect(close).toContainText('Aprobată');
  await close.getByRole('button', { name: 'Închide luna', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Luna a fost închisă.');
  await expect(close).toContainText('Luna închisă');
  await expect(january).toContainText('închisă');
  await expect(january).not.toContainText('deschisă');
  await expect(january.getByRole('button', { name: /Verifică luna/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
