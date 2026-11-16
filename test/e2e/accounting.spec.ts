import { expect, test } from '@playwright/test';
import { approveAndPost, keep, openProposal, signInWithCompany } from './support/session';

test('a reviewed opening is posted, reported and closed', async ({ page }, info) => {
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Servicii ${info.project.name} SRL`,
  );
  await keep(page, 'balanta-deschidere.pdf', 'Balanța de deschidere 2026');

  await page.getByRole('button', { name: 'De verificat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('proposals');
  await expect(
    page.getByText('Niciun element pentru filtrele alese.', { exact: true }),
  ).toBeVisible();
  await page.getByText('Notă contabilă nouă', { exact: true }).click();
  await page.getByLabel('Data', { exact: true }).fill('2026-01-01');
  await page.getByRole('combobox', { name: 'Tip', exact: true }).selectOption('opening');
  await page.getByLabel('Referință', { exact: true }).fill('DESCHIDERE-2026');
  await page.getByLabel('Explicație', { exact: true }).fill('Sold inițial la bancă');
  const accounts = page.getByLabel('Cont', { exact: true });
  const amounts = page.getByLabel('Sumă (lei)', { exact: true });
  await accounts.nth(0).fill('5121');
  await amounts.nth(0).fill('1000,00');
  await accounts.nth(1).fill('1012');
  await amounts.nth(1).fill('1000,00');
  await page.getByRole('button', { name: 'Pregătește propunerea', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('pregătită pentru verificare');

  const proposal = await openProposal(page);
  await expect(
    proposal.getByRole('heading', { name: 'Notă contabilă', exact: true }),
  ).toBeVisible();
  await expect(proposal.getByRole('cell', { name: '5121', exact: true })).toBeVisible();
  await approveAndPost(page);
  await expect(page.locator('.acc-balances')).toContainText('1 000,00 RON');

  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(page.getByRole('cell', { name: '5121', exact: true })).toBeVisible();
  await expect(page.getByText(/1\. 2026-01-01 · DESCHIDERE · Sold inițial la bancă/)).toBeVisible();

  await page.getByRole('button', { name: 'Setări', exact: true }).click();
  await page.getByRole('button', { name: 'Luni', exact: true }).click();
  await page.getByLabel('Luna', { exact: true }).fill('2026-01');
  await page.getByRole('button', { name: 'Verifică luna', exact: true }).click();
  await expect(page.getByText('Nicio constatare.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Aprobă închiderea', exact: true }).click();
  await page.getByRole('button', { name: 'Închide luna', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Luna a fost închisă.');
  await expect(page.getByText('2026-01: închisă', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
