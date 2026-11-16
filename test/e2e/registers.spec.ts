import { expect, test, type Page } from '@playwright/test';
import type { ProposalView } from '../../packages/xfactura-api/source/engine/contracts';
import {
  invoiceXml,
  type XmlInput,
} from '../../packages/xfactura-api/test/engine/fixtures/invoice';
import { capability, evidence } from './support/books';
import { signInWithCompany } from './support/session';

/** Books one proposal through the public contract, as a person approving its exact hash. */
async function book(page: Page, treatment: string, input: Record<string, unknown>) {
  const proposal = await capability<ProposalView>(page, 'proposals.propose', { treatment, input });
  expect(proposal.status).toBe('proposed');
  const binding = {
    proposalId: proposal.id,
    version: proposal.version,
    effectHash: proposal.effectHash,
  };
  await capability(page, 'proposals.approve', binding);
  const posted = await capability<ProposalView>(page, 'ledger.post', binding);
  expect(posted.status).toBe('posted');
  return posted;
}

/** Imports a synthetic e-Factura invoice and books it on the given revenue or expense account. */
async function bookInvoice(page: Page, xml: XmlInput, account: string) {
  const file = await evidence(page, `${xml.number}.xml`, invoiceXml(xml), 'application/xml');
  const document = await capability<{ id: string }>(page, 'invoices.import', {
    evidenceId: file.id,
  });
  return book(page, 'invoices.recognize', { documentId: document.id, account });
}

async function recordFact(page: Page, axis: string, value: string, effectiveFrom: string) {
  const proof = await evidence(page, `${axis}.pdf`, 'Certificat sintetic');
  await capability(page, 'profile.record', { axis, value, effectiveFrom, evidenceId: proof.id });
}

async function addCompany(page: Page, name: string) {
  await page.getByText('Adaugă o companie', { exact: true }).click();
  await page.getByLabel('Denumire companie', { exact: true }).fill(name);
  await page.getByLabel('CUI', { exact: true }).fill('12345678');
  await page.getByLabel('An contabil', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Adaugă compania', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const companyForm = page.locator('.acc-company-toolbar > details[open] > summary');
  if (await companyForm.isVisible()) await companyForm.click();
}

/** The value of a term in the entry's details, by its label. */
const detail = (page: Page, term: string) =>
  page
    .locator('.acc-content .acc-work-details > div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${term}$`) }) })
    .locator('dd');

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

/** The first register table shows every column without scrolling sideways. */
async function wholeTable(page: Page) {
  const scroll = page.locator('.acc-content .acc-table-scroll').first();
  await expect(scroll).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

test('the trial balance leads to the account sheet, an entry with its proposal and evidence, and a VAT row opens its entry', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const phone = info.project.name === 'mobile';
  const person = `accounting-${info.project.name}`;
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Registre ${info.project.name} SRL`,
  );
  await recordFact(page, 'vat.status', 'normal_vat', '2026-01-01');
  const sale = await bookInvoice(
    page,
    {
      direction: 'sale',
      number: 'FV-1',
      date: '2026-01-15',
      net: '100.00',
      tax: '21.00',
      gross: '121.00',
    },
    '704',
  );
  await bookInvoice(
    page,
    { number: 'FP-1', date: '2026-01-20', net: '50.00', tax: '10.50', gross: '60.50' },
    '628',
  );
  const content = page.locator('.acc-content');

  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await expect(content.getByRole('heading', { name: 'Balanța de verificare' })).toBeVisible();
  const month = content.getByLabel('Luna', { exact: true });
  await expect(month).not.toHaveValue('');
  // The month the view shows is in the address before anyone changes it.
  await expect(page).toHaveURL(new RegExp(`registerMonth=${await month.inputValue()}`));
  await month.fill('2026-01');
  await expect(page).toHaveURL(/registerMonth=2026-01/);

  const clients = content
    .locator('.acc-trial-table tbody tr')
    .filter({ has: page.getByRole('link', { name: /^4111 / }) });
  await expect(clients.locator('td[data-label="Sold final · Debit"]')).toHaveText('121,00');
  await expect(clients.locator('td[data-label="Sold final · Debit"]')).toBeVisible();
  const turnover = clients.locator('td[data-label="Rulaje curente · Debit"]');
  if (phone) {
    await expect(turnover).toBeHidden();
    await clients
      .getByRole('button', { name: 'Toate coloanele pentru contul 4111', exact: true })
      .click();
  } else {
    await wholeTable(page);
  }
  await expect(turnover).toBeVisible();
  await expect(turnover).toHaveText('121,00');
  await noPageOverflow(page);

  await clients.getByRole('link', { name: /^4111 / }).click();
  await expect(page).toHaveURL(/register=fisa/);
  await expect(page).toHaveURL(/registerAccount=4111/);
  await expect(page).toHaveURL(/registerMonth=2026-01/);
  await expect(content.getByRole('heading', { name: /^4111 / })).toBeVisible();
  await expect(
    content.locator('.acc-review-meta > div').filter({ hasText: 'Rulaj debit' }).locator('dd'),
  ).toHaveText('121,00 RON');
  const correspondent = content
    .locator('tbody tr')
    .filter({ has: page.locator('td[data-label="Cont corespondent"]', { hasText: '704' }) });
  await expect(correspondent.locator('td[data-label="Debit"]')).toHaveText('121,00');
  await expect(content.getByText(/nu deschid înregistrările din care provin/)).toBeVisible();

  await content.getByRole('link', { name: 'Registrul jurnal', exact: true }).click();
  await expect(page).toHaveURL(/register=jurnal/);
  const journalRow = content.locator('.acc-journal-row').filter({ hasText: 'FV-1' });
  // Tapping the row expands it; opening the entry is its own link.
  await journalRow.locator('summary').click();
  await expect(journalRow.locator('details')).toHaveAttribute('open', '');
  await expect(journalRow.getByText('Debit 4111 · 121,00 RON')).toBeVisible();
  await expect(page).not.toHaveURL(/registerEntry=/);
  await journalRow
    .getByRole('link', { name: /^Deschide înregistrarea \d+ din 2026-01-15$/ })
    .click();

  await expect(page).toHaveURL(/registerEntryDate=2026-01-15/);
  const entryHeading = content.getByRole('heading', {
    name: `Înregistrarea ${sale.entry!.number} · 2026-01-15`,
  });
  await expect(entryHeading).toBeVisible();
  await expect(entryHeading).toBeFocused();
  await expect(detail(page, 'Document justificativ')).toContainText('FV-1');
  const debit = content
    .locator('tbody tr')
    .filter({ has: page.locator('td[data-label="Cont"]', { hasText: /^4111$/ }) });
  await expect(debit.locator('td[data-label="Debit"]')).toHaveText('121,00');
  await expect(detail(page, 'Propusă de')).toHaveText(person);
  await expect(detail(page, 'Aprobată de')).toHaveText(
    new RegExp(`^${person} · \\d{2}\\.\\d{2}\\.\\d{4}, \\d{2}:\\d{2}$`),
  );
  await expect(detail(page, 'Amprenta efectului aprobat')).toHaveText(sale.effectHash);
  await expect(detail(page, 'Contabilizată de')).toHaveText(person);
  await expect(content.getByRole('link', { name: 'Descarcă documentul original' })).toBeVisible();
  await expect(content.locator('.acc-evidence-text')).toContainText('<cbc:ID>FV-1</cbc:ID>');
  await noPageOverflow(page);

  await content.getByRole('button', { name: 'Înapoi la registru', exact: true }).click();
  await expect(page).not.toHaveURL(/registerEntry=/);
  await expect(page).toHaveURL(/register=jurnal/);
  await expect(page).toHaveURL(/registerMonth=2026-01/);

  await content.getByRole('button', { name: 'Jurnale de TVA', exact: true }).click();
  await expect(
    content.getByRole('combobox', { name: 'Perioada fiscală de TVA', exact: true }),
  ).toHaveValue('2026-01');
  await expect(page).toHaveURL(/vatPeriod=2026-01/);
  const sales = content.getByRole('region', { name: 'Jurnal de vânzări', exact: true });
  const saleRow = sales.locator('tbody tr').filter({ hasText: 'FV-1' });
  await expect(saleRow.locator('td[data-label="Bază"]')).toHaveText('100,00');
  await expect(saleRow.locator('td[data-label="TVA"]')).toHaveText('21,00');
  const purchases = content.getByRole('region', { name: 'Jurnal de cumpărări', exact: true });
  const purchaseRow = purchases.locator('tbody tr').filter({ hasText: 'FP-1' });
  await expect(purchaseRow.locator('td[data-label="TVA deductibilă"]')).toHaveText('10,50');
  await noPageOverflow(page);
  await saleRow
    .getByRole('link', { name: `Deschide înregistrarea ${sale.entry!.number} din 2026-01-15` })
    .click();
  await expect(entryHeading).toBeFocused();
  await expect(detail(page, 'Document justificativ')).toContainText('FV-1');
  await content.getByRole('button', { name: 'Înapoi la registru', exact: true }).click();

  await content.getByRole('button', { name: 'Registrul inventar', exact: true }).click();
  const receivable = content
    .locator('.acc-inventory-table tbody tr')
    .filter({ has: page.locator('td[data-label="Cont"]', { hasText: /^4111 / }) });
  await expect(receivable.locator('.acc-item-list li')).toContainText('debit 121,00');
  await expect(receivable.locator('td[data-label="Diferență credit"]')).toBeVisible();
  if (!phone) await wholeTable(page);
  await noPageOverflow(page);
  expect(errors).toEqual([]);
});

test('VAT rows open their own entries across financial years, and a quarterly payer sees its quarter', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  const errors = await signInWithCompany(
    page,
    info,
    'accounting',
    `Registre TVA ${info.project.name} SRL`,
  );
  await capability(page, 'years.create', {
    kind: 'financial',
    label: '2025',
    from: '2025-01-01',
    to: '2025-12-31',
  });
  await recordFact(page, 'vat.status', 'normal_vat', '2025-01-01');
  const sale = await bookInvoice(
    page,
    {
      direction: 'sale',
      number: 'V-2025',
      date: '2025-12-15',
      net: '300.00',
      tax: '63.00',
      gross: '363.00',
    },
    '704',
  );
  // Issued in 2026 for a December supply: its VAT belongs to 2025-12, its entry to the 2026 year.
  const purchase = await bookInvoice(
    page,
    {
      number: 'FP-X',
      date: '2026-01-10',
      deliveryDate: '2025-12-20',
      net: '50.00',
      tax: '10.50',
      gross: '60.50',
    },
    '628',
  );
  // Both are the first entry of their year: a number alone cannot tell them apart.
  expect(purchase.entry!.number).toBe(sale.entry!.number);
  const number = sale.entry!.number;
  const content = page.locator('.acc-content');

  await page.reload();
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await page.getByRole('combobox', { name: 'Exercițiu', exact: true }).selectOption({
    label: '2025',
  });
  await content.getByRole('button', { name: 'Jurnale de TVA', exact: true }).click();
  const period = content.getByRole('combobox', { name: 'Perioada fiscală de TVA', exact: true });
  await period.selectOption('2025-12');
  await expect(page).toHaveURL(/vatPeriod=2025-12/);
  const purchases = content.getByRole('region', { name: 'Jurnal de cumpărări', exact: true });
  await purchases
    .getByRole('link', { name: `Deschide înregistrarea ${number} din 2026-01-10`, exact: true })
    .click();
  await expect(
    content.getByRole('heading', { name: `Înregistrarea ${number} · 2026-01-10` }),
  ).toBeFocused();
  await expect(detail(page, 'Document justificativ')).toContainText('FP-X');
  await content.getByRole('button', { name: 'Înapoi la registru', exact: true }).click();
  const sales = content.getByRole('region', { name: 'Jurnal de vânzări', exact: true });
  await sales
    .getByRole('link', { name: `Deschide înregistrarea ${number} din 2025-12-15`, exact: true })
    .click();
  await expect(
    content.getByRole('heading', { name: `Înregistrarea ${number} · 2025-12-15` }),
  ).toBeFocused();
  await expect(detail(page, 'Document justificativ')).toContainText('V-2025');
  await noPageOverflow(page);

  await addCompany(page, `Trimestrial ${info.project.name} SRL`);
  await recordFact(page, 'vat.status', 'normal_vat', '2026-01-01');
  await recordFact(page, 'vat.period', 'quarterly', '2026-01-01');
  const quarterly = await bookInvoice(
    page,
    {
      direction: 'sale',
      number: 'FQ-1',
      date: '2026-01-15',
      net: '100.00',
      tax: '21.00',
      gross: '121.00',
    },
    '704',
  );
  await page.getByRole('button', { name: 'Registre', exact: true }).click();
  await content.getByLabel('Luna', { exact: true }).fill('2026-02');
  await expect(page).toHaveURL(/registerMonth=2026-02/);
  await content.getByRole('button', { name: 'Jurnale de TVA', exact: true }).click();
  // February lies in the first quarter, the company's VAT period.
  await expect(period).toHaveValue('2026-Q1');
  await expect(period.locator('option')).toHaveText([
    'Trimestrul 1 2026',
    'Trimestrul 2 2026',
    'Trimestrul 3 2026',
    'Trimestrul 4 2026',
  ]);
  const quarterRow = sales.locator('tbody tr').filter({ hasText: 'FQ-1' });
  await expect(quarterRow.locator('td[data-label="TVA"]')).toHaveText('21,00');
  await quarterRow
    .getByRole('link', {
      name: `Deschide înregistrarea ${quarterly.entry!.number} din 2026-01-15`,
      exact: true,
    })
    .click();
  await expect(detail(page, 'Document justificativ')).toContainText('FQ-1');
  await noPageOverflow(page);
  expect(errors).toEqual([]);
});
