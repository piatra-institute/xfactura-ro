import { expect, type Page, type TestInfo } from '@playwright/test';

/** Signs in the person seeded for this spec and browser project, and creates their company. */
export async function signInWithCompany(page: Page, info: TestInfo, spec: string, name: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/contabilitate');
  await expect(page.getByRole('heading', { name: 'Autentificare', exact: true })).toBeVisible();
  await expect(page.locator('.accounting')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await page.getByLabel('Email', { exact: true }).fill(`${spec}-${info.project.name}@example.test`);
  await page.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Companie nouă', exact: true })).toBeVisible();
  await page.getByLabel('Denumire companie', { exact: true }).fill(name);
  await page.getByLabel('CUI', { exact: true }).fill('12345678');
  await page.getByLabel('An contabil', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return errors;
}

export async function keep(page: Page, name: string, content: string, mimeType = 'text/plain') {
  await page.getByRole('button', { name: 'Documente', exact: true }).click();
  await page
    .getByLabel('Document original', { exact: true })
    .setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
  await page.getByRole('button', { name: 'Păstrează documentul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${name} a fost păstrat.`);
}

export async function recordVatPayer(page: Page, evidence: string) {
  await page.getByRole('button', { name: 'Configurare', exact: true }).click();
  await page.getByRole('combobox', { name: 'Axă', exact: true }).selectOption('vat.status');
  await page.getByRole('combobox', { name: 'Valoare', exact: true }).selectOption('normal_vat');
  await page.getByLabel('De la', { exact: true }).fill('2026-01-01');
  await page
    .getByRole('combobox', { name: 'Document justificativ', exact: true })
    .selectOption({ label: evidence });
  await page.getByRole('button', { name: 'Înregistrează faptul', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Faptul a fost înregistrat.');
}

/** Approves and posts the first open proposal on the review tab. */
export async function approveAndPost(page: Page) {
  await page.getByRole('button', { name: 'De verificat', exact: true }).click();
  const proposal = page.locator('.acc-review').first();
  await proposal.getByRole('button', { name: 'Aprobă această versiune', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Versiunea a fost aprobată.');
  await page
    .locator('.acc-review')
    .first()
    .getByRole('button', { name: 'Contabilizează', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Înregistrarea a fost contabilizată.');
}
