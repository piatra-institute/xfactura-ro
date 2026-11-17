import { expect, type Page, type TestInfo } from '@playwright/test';
import { changeFact, openProfile } from './profile';
import { chooseOption, createCompany, expectTheme, openSection } from './shell';
import { openWorkRow } from './worklist';

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
  // The browser reports a light system theme unless a test asks otherwise.
  await expectTheme(page, 'light');
  await page.getByLabel('Email', { exact: true }).fill(`${spec}-${info.project.name}@example.test`);
  await page.getByLabel('Parolă', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Intră în cont', exact: true }).click();
  await expect(page.locator('.acc-app')).toBeVisible();
  await createCompany(page, name, cui);
  return errors;
}

/** Keeps an original document from Documente, reached by the context bar's primary action. */
export async function keep(page: Page, name: string, content: string, mimeType = 'text/plain') {
  // The company's setup has no context bar action: from it, Documente opens from the sidebar.
  const add = page.getByRole('link', { name: 'Adaugă documente', exact: true });
  const documents = page.getByRole('heading', { level: 1, name: 'Documente', exact: true });
  if (await add.isVisible()) await add.click();
  else if (!(await documents.isVisible())) await openSection(page, 'Documente');
  await expect(documents).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Alege fișiere', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(content) });
  await expect(page.getByRole('status')).toContainText(`${name} a fost păstrat.`);
}

/** Records the company as a VAT payer from 1 January 2026, citing a kept document. */
export async function recordVatPayer(page: Page, evidence: string) {
  await openProfile(page);
  await changeFact(page, 'Regimul de TVA', 'Plătitor de TVA', '01.01.2026', evidence);
}

/** Opens the first proposal from the worklist, preserving the human decision and exact hash. */
export async function openProposal(page: Page) {
  await openSection(page, 'De verificat');
  await chooseOption(page, 'Familie', 'Propuneri');
  const item = page.locator('[data-work-kind="proposal.awaitingApproval"]').first();
  await expect(item).toBeVisible();
  await openWorkRow(item);
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
