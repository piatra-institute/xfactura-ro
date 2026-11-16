import { expect, type Page, type TestInfo } from '@playwright/test';

/** Signs in the person seeded for this spec and browser project, and creates their company. */
export async function signInWithCompany(
  page: Page,
  info: TestInfo,
  spec: string,
  name: string,
  cui = '12345678',
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/contabilitate');
  await expect(page.getByRole('heading', { name: 'Autentificare', exact: true })).toBeVisible();
  await expect(page.locator('.accounting')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.getByLabel('Email', { exact: true }).fill(`${spec}-${info.project.name}@example.test`);
  await page.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Deconectare', exact: true })).toBeVisible();
  if (!(await page.getByRole('heading', { name: 'Companie nouă', exact: true }).isVisible()))
    await page.getByText('Adaugă o companie', { exact: true }).click();
  await page.getByLabel('Denumire companie', { exact: true }).fill(name);
  await page.getByLabel('CUI', { exact: true }).fill(cui);
  await page.getByLabel('An contabil', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const companyForm = page.locator('.acc-company-toolbar > details[open] > summary');
  if (await companyForm.isVisible()) await companyForm.click();
  return errors;
}

export async function keep(page: Page, name: string, content: string, mimeType = 'text/plain') {
  await page.getByRole('button', { name: 'Adaugă documente', exact: true }).click();
  await page
    .getByLabel('Document original', { exact: true })
    .setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
  await page.getByRole('button', { name: 'Păstrează documentul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${name} a fost păstrat.`);
}

export async function recordVatPayer(page: Page, evidence: string) {
  await page.getByRole('button', { name: 'Setări', exact: true }).click();
  await page.getByRole('combobox', { name: 'Axă', exact: true }).selectOption('vat.status');
  await page.getByRole('combobox', { name: 'Valoare', exact: true }).selectOption('normal_vat');
  await page.getByLabel('De la', { exact: true }).fill('2026-01-01');
  await page
    .getByRole('combobox', { name: 'Document justificativ', exact: true })
    .selectOption({ label: evidence });
  await page.getByRole('button', { name: 'Înregistrează faptul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
}

/** Opens the first proposal from the worklist, preserving the human decision and exact hash. */
export async function openProposal(page: Page) {
  await page.getByRole('button', { name: 'De verificat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Familie', exact: true }).selectOption('proposals');
  const item = page.locator('[data-work-kind="proposal.awaitingApproval"]').first();
  await expect(item).toBeVisible();
  if ((await item.getAttribute('open')) === null) await item.locator('summary').click();
  return item.locator('.acc-review');
}

/** Approves and posts the first open proposal on De verificat. */
export async function approveAndPost(page: Page) {
  const proposal = await openProposal(page);
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Versiunea a fost aprobată.');
  await page
    .locator('.acc-review')
    .first()
    .getByRole('button', { name: 'Contabilizează', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Înregistrarea a fost contabilizată.');
}
